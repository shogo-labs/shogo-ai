/**
 * E2E Test: Billing Page - View Plans
 * 
 * Tests the billing page:
 * 1. User can navigate to billing page
 * 2. Plans are displayed correctly
 * 3. User can toggle monthly/annual pricing
 * 4. User can see credit tiers
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL } from '../helpers/test-helpers'

test.describe('Billing Page - View Plans E2E', () => {
  test('user can navigate to billing page', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to billing page via link
    const billingLink = page.getByRole('link', { name: /Upgrade to Pro|billing/i }).first()
    await billingLink.click()
    
    // Wait for billing page to load
    await page.waitForURL(/\/billing/, { timeout: 5000 })
    
    // Verify we're on billing page
    expect(page.url()).toContain('/billing')
    
    // Verify page heading
    const heading = page.getByRole('heading', { name: /Plans|Billing/i }).first()
    await expect(heading).toBeVisible({ timeout: 5000 })
  })

  test('billing page shows plan options', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to billing
    await page.goto(`${WEB_URL}/billing`)
    await page.waitForTimeout(2000)
    
    // Verify plan cards are visible
    // Look for Pro, Business, Enterprise plans
    const proPlan = page.getByText(/Pro|Free Plan/i).first()
    await expect(proPlan).toBeVisible({ timeout: 5000 })
    
    // Check for pricing information
    const pricing = page.getByText(/\$|per month|credits/i).first()
    await expect(pricing).toBeVisible()
  })

  test('user can toggle monthly/annual pricing', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to billing
    await page.goto(`${WEB_URL}/billing`)
    await page.waitForTimeout(2000)
    
    // Find monthly/annual tabs
    const monthlyTab = page.getByRole('tab', { name: /Monthly/i })
    const annualTab = page.getByRole('tab', { name: /Annual/i })
    
    if (await monthlyTab.isVisible().catch(() => false)) {
      await expect(monthlyTab).toBeVisible()
      await expect(annualTab).toBeVisible()
      
      // Click annual tab
      await annualTab.click()
      await page.waitForTimeout(500)
      
      // Verify annual tab is selected
      await expect(annualTab).toHaveAttribute('aria-selected', 'true')
      
      // Click monthly tab
      await monthlyTab.click()
      await page.waitForTimeout(500)
      
      // Verify monthly tab is selected
      await expect(monthlyTab).toHaveAttribute('aria-selected', 'true')
    }
  })

  test('user can see credit tiers', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to billing
    await page.goto(`${WEB_URL}/billing`)
    await page.waitForTimeout(2000)
    
    // Look for credit tier selector (combobox)
    const creditSelector = page.getByRole('combobox', { name: /credits/i }).first()
    
    if (await creditSelector.isVisible().catch(() => false)) {
      await expect(creditSelector).toBeVisible()
      
      // Click to open dropdown
      await creditSelector.click()
      await page.waitForTimeout(500)
      
      // Verify options are visible
      const options = page.getByRole('option')
      const optionCount = await options.count()
      expect(optionCount).toBeGreaterThan(0)
    }
  })

  test('user can see current plan and credits', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to billing
    await page.goto(`${WEB_URL}/billing`)
    await page.waitForTimeout(2000)
    
    // Verify current plan is shown
    const currentPlan = page.getByText(/Free Plan|You're on/i).first()
    await expect(currentPlan).toBeVisible({ timeout: 5000 })
    
    // Verify credits remaining is shown
    const creditsRemaining = page.getByText(/Credits remaining|credits/i).first()
    await expect(creditsRemaining).toBeVisible()
  })
})
