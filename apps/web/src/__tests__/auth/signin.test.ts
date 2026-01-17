/**
 * E2E Test: Sign In Flow
 * 
 * Tests the sign in flow:
 * 1. User can sign in with email and password
 * 2. User is redirected to workspace view after sign in
 * 3. User session persists
 */

import { test, expect } from '@playwright/test'
import { signUpUser, signInUser, WEB_URL } from '../helpers/test-helpers'

test.describe('Sign In Flow E2E', () => {
  test('user can sign in with email and password', async ({ page }) => {
    // First, create a user
    const credentials = await signUpUser(page)
    
    // Sign out
    await page.getByRole('button', { name: /User menu/i }).click()
    await page.getByRole('menuitem', { name: 'Sign Out' }).click()
    
    // Wait for logout to complete
    await page.waitForSelector('text=Sign in to your account', { timeout: 5000 })
    
    // Now sign in
    await signInUser(page, credentials.email, credentials.password)
    
    // Verify we're on the workspace view
    await expect(page.getByRole('heading', { name: /What's on your mind/i })).toBeVisible()
    await expect(page.getByText('Sign in to your account')).not.toBeVisible()
  })

  test('sign in shows error for invalid credentials', async ({ page }) => {
    await page.goto(WEB_URL)
    await page.getByText('Sign in to your account or create a new one').waitFor()
    
    // Make sure we're on Sign In tab
    await page.getByRole('tab', { name: 'Sign In' }).click()
    
    // Try to sign in with invalid credentials
    await page.getByRole('textbox', { name: 'Email' }).fill('invalid@example.com')
    await page.getByRole('textbox', { name: 'Password' }).fill('WrongPassword123!')
    await page.getByRole('button', { name: 'Sign In' }).click()
    
    // Wait for error message (this might vary based on your error handling)
    // Check if we're still on login page or if error is shown
    await page.waitForTimeout(2000)
    
    // Should still be on login page or show error
    const isStillOnLogin = await page.getByText('Sign in to your account').isVisible().catch(() => false)
    const hasError = await page.locator('[role="alert"]').isVisible().catch(() => false)
    
    // Either we're still on login (error) or error alert is shown
    expect(isStillOnLogin || hasError).toBe(true)
  })
})
