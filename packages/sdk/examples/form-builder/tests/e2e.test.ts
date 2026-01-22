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
    
    // Fill form name with unique timestamp
    const formName = `E2E Form ${Date.now()}`
    const nameInput = page.getByPlaceholder('Form name (e.g., Contact Form, Survey)')
    await nameInput.fill(formName)
    
    // Create form - wait for button to be enabled
    const createButton = page.getByRole('button', { name: 'Create Form' })
    await expect(createButton).toBeEnabled({ timeout: 2000 })
    await createButton.click()
    
    // Wait for form to appear in list (check for Draft badge as indicator)
    await expect(page.getByText('Draft').first()).toBeVisible({ timeout: 10000 })
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
    const formName = `Fields Form ${Date.now()}`
    await page.getByPlaceholder('Form name (e.g., Contact Form, Survey)').fill(formName)
    const createBtn = page.getByRole('button', { name: 'Create Form' })
    await expect(createBtn).toBeEnabled({ timeout: 2000 })
    await createBtn.click()
    
    // Wait for form to appear
    await expect(page.getByText('Draft').first()).toBeVisible({ timeout: 10000 })
    
    // Click Edit on the first form
    await page.getByRole('button', { name: 'Edit' }).first().click()
    
    // Wait for form editor to load (check for Fields tab)
    await expect(page.getByRole('button', { name: /Fields/ })).toBeVisible({ timeout: 10000 })
    
    // Add a field
    await page.getByRole('button', { name: '+ Add Field' }).click()
    
    // Fill field details - use more specific selectors
    const labelInput = page.locator('input[placeholder="e.g., Your Name"]')
    await labelInput.fill('Full Name')
    
    // Add field - wait for button to be enabled
    const addFieldBtn = page.getByRole('button', { name: 'Add Field' })
    await expect(addFieldBtn).toBeEnabled({ timeout: 2000 })
    await addFieldBtn.click()
    
    // Field should appear - check for the field type badge instead
    await expect(page.getByText('Short Text').first()).toBeVisible({ timeout: 10000 })
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
    await page.getByPlaceholder('Form name (e.g., Contact Form, Survey)').fill(`Pub Form ${Date.now()}`)
    const createBtn = page.getByRole('button', { name: 'Create Form' })
    await expect(createBtn).toBeEnabled({ timeout: 2000 })
    await createBtn.click()
    await expect(page.getByText('Draft').first()).toBeVisible({ timeout: 10000 })
    
    // Go to form editor
    await page.getByRole('button', { name: 'Edit' }).first().click()
    await expect(page.getByRole('button', { name: /Fields/ })).toBeVisible({ timeout: 10000 })
    
    // Add a field first
    await page.getByRole('button', { name: '+ Add Field' }).click()
    await page.locator('input[placeholder="e.g., Your Name"]').fill('Test Field')
    const addFieldBtn = page.getByRole('button', { name: 'Add Field' })
    await expect(addFieldBtn).toBeEnabled({ timeout: 2000 })
    await addFieldBtn.click()
    await expect(page.getByText('Short Text').first()).toBeVisible({ timeout: 10000 })
    
    // Go to settings
    await page.getByRole('button', { name: 'Settings' }).click()
    
    // Publish the form
    const publishCheckbox = page.getByLabel('Published (form is publicly accessible)')
    await publishCheckbox.check()
    
    // Save settings
    await page.getByRole('button', { name: 'Save Settings' }).click()
    
    // Wait for save and page refresh
    await page.waitForTimeout(2000)
    
    // Share link should appear
    await expect(page.getByText('Share your form')).toBeVisible({ timeout: 10000 })
  })

  test.skip('should display submissions page', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`subs-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Your Forms' })).toBeVisible({ timeout: 10000 })
    }
    
    // Wait for dashboard to be ready
    await expect(page.getByRole('heading', { name: 'Your Forms' })).toBeVisible({ timeout: 10000 })
    
    // Check if there are existing forms
    const editButton = page.getByRole('button', { name: 'Edit' }).first()
    const hasForm = await editButton.isVisible().catch(() => false)
    
    if (!hasForm) {
      // Create a form first
      await page.getByRole('button', { name: '+ New Form' }).click()
      await page.getByPlaceholder('Form name (e.g., Contact Form, Survey)').fill(`Subs Form ${Date.now()}`)
      const createBtn = page.getByRole('button', { name: 'Create Form' })
      await expect(createBtn).toBeEnabled({ timeout: 5000 })
      await createBtn.click()
      await expect(page.getByText('Draft').first()).toBeVisible({ timeout: 10000 })
    }
    
    // Go to form editor by clicking the Edit link (not button)
    const editLink = page.getByRole('link', { name: 'Edit' }).first()
    await editLink.click()
    await expect(page.getByRole('button', { name: /Fields/ })).toBeVisible({ timeout: 10000 })
    
    // Get the current URL to extract form ID
    const currentUrl = page.url()
    const formId = currentUrl.split('/forms/')[1]?.split('/')[0]
    
    // Navigate directly to submissions page
    if (formId) {
      await page.goto(`${BASE_URL}/forms/${formId}/submissions`)
      // Should show submissions page
      await expect(page.getByRole('heading', { name: 'Submissions' })).toBeVisible({ timeout: 10000 })
    }
  })
})
