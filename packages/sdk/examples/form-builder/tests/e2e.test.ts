/**
 * Form Builder E2E Tests
 * 
 * Tests the Shogo SDK patterns:
 * - Dynamic field schemas
 * - Position ordering
 * - JSON fields
 * - Nested includes
 * - Slug-based URLs
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

test.describe('Form Builder - Shogo SDK Example', () => {

  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Should show either setup or dashboard
    const setupTitle = page.getByRole('heading', { name: 'Form Builder' })
    const dashboardTitle = page.getByRole('heading', { name: 'Your Forms' })
    
    const hasSetup = await setupTitle.isVisible().catch(() => false)
    const hasDashboard = await dashboardTitle.isVisible().catch(() => false)
    
    expect(hasSetup || hasDashboard).toBe(true)
  })

  test('should create user if on setup', async ({ page }) => {
    await page.goto(BASE_URL)
    
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Your Forms' })).toBeVisible({ timeout: 10000 })
    }
  })

  test('should create a new form', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`form-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Your Forms' })).toBeVisible({ timeout: 10000 })
    }
    
    // Click new form button
    await page.getByRole('button', { name: '+ New Form' }).click()
    
    // Fill form name
    const nameInput = page.getByPlaceholder('Form name (e.g., Contact Form, Survey)')
    await nameInput.fill('E2E Test Form')
    
    // Create form
    await page.getByRole('button', { name: 'Create Form' }).click()
    
    // Should see the form in the list
    await expect(page.getByText('E2E Test Form')).toBeVisible({ timeout: 5000 })
  })

  test('should edit form and add fields', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`field-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Your Forms' })).toBeVisible({ timeout: 10000 })
    }
    
    // Create a form first
    await page.getByRole('button', { name: '+ New Form' }).click()
    await page.getByPlaceholder('Form name (e.g., Contact Form, Survey)').fill('Field Test Form')
    await page.getByRole('button', { name: 'Create Form' }).click()
    await expect(page.getByText('Field Test Form')).toBeVisible({ timeout: 5000 })
    
    // Click Edit
    await page.getByRole('button', { name: 'Edit' }).first().click()
    
    // Should be on form editor
    await expect(page.getByRole('heading', { name: 'Field Test Form' })).toBeVisible({ timeout: 5000 })
    
    // Add a field
    await page.getByRole('button', { name: '+ Add Field' }).click()
    
    // Fill field details
    await page.getByLabel('Label *').fill('Your Name')
    await page.getByLabel('Placeholder').fill('Enter your name')
    
    // Add field
    await page.getByRole('button', { name: 'Add Field' }).click()
    
    // Field should appear
    await expect(page.getByText('Your Name')).toBeVisible({ timeout: 5000 })
  })

  test('should publish and view form', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`publish-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Your Forms' })).toBeVisible({ timeout: 10000 })
    }
    
    // Create a form
    await page.getByRole('button', { name: '+ New Form' }).click()
    await page.getByPlaceholder('Form name (e.g., Contact Form, Survey)').fill('Publish Test Form')
    await page.getByRole('button', { name: 'Create Form' }).click()
    await expect(page.getByText('Publish Test Form')).toBeVisible({ timeout: 5000 })
    
    // Go to form editor
    await page.getByRole('button', { name: 'Edit' }).first().click()
    await expect(page.getByRole('heading', { name: 'Publish Test Form' })).toBeVisible({ timeout: 5000 })
    
    // Add a field first
    await page.getByRole('button', { name: '+ Add Field' }).click()
    await page.getByLabel('Label *').fill('Test Field')
    await page.getByRole('button', { name: 'Add Field' }).click()
    await expect(page.getByText('Test Field')).toBeVisible({ timeout: 5000 })
    
    // Go to settings
    await page.getByRole('button', { name: 'Settings' }).click()
    
    // Publish the form
    const publishCheckbox = page.getByLabel('Published (form is publicly accessible)')
    await publishCheckbox.check()
    
    // Save settings
    await page.getByRole('button', { name: 'Save Settings' }).click()
    
    // Wait for save
    await page.waitForTimeout(1000)
    
    // Preview button should appear - check if there's a share link now
    await expect(page.getByText('Share your form')).toBeVisible({ timeout: 5000 })
  })

  test('should display submissions page', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`submissions-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Your Forms' })).toBeVisible({ timeout: 10000 })
    }
    
    // Create a form
    await page.getByRole('button', { name: '+ New Form' }).click()
    await page.getByPlaceholder('Form name (e.g., Contact Form, Survey)').fill('Submissions Test')
    await page.getByRole('button', { name: 'Create Form' }).click()
    await expect(page.getByText('Submissions Test')).toBeVisible({ timeout: 5000 })
    
    // Go to form editor
    await page.getByRole('button', { name: 'Edit' }).first().click()
    
    // Click submissions button
    await page.getByRole('button', { name: /Submissions/ }).click()
    
    // Should show submissions page
    await expect(page.getByRole('heading', { name: 'Submissions' })).toBeVisible({ timeout: 5000 })
  })
})
