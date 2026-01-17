/**
 * E2E Test: Sign Out Flow
 * 
 * Tests the sign out flow:
 * 1. User can sign out from user menu
 * 2. User is redirected to login page after sign out
 * 3. User cannot access protected routes after sign out
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL } from '../helpers/test-helpers'

test.describe('Sign Out Flow E2E', () => {
  test('user can sign out from user menu', async ({ page }) => {
    // First, sign up a user
    await signUpUser(page)
    
    // Verify we're logged in
    await expect(page.getByRole('heading', { name: /What's on your mind/i })).toBeVisible()
    
    // Open user menu
    await page.getByRole('button', { name: /User menu/i }).click()
    
    // Click Sign Out
    await page.getByRole('menuitem', { name: 'Sign Out' }).click()
    
    // Wait for redirect to login page
    await page.waitForSelector('text=Sign in to your account', { timeout: 5000 })
    
    // Verify we're on login page
    await expect(page.getByText('Sign in to your account or create a new one')).toBeVisible()
    await expect(page.getByRole('heading', { name: /What's on your mind/i })).not.toBeVisible()
  })

  test('user cannot access protected routes after sign out', async ({ page }) => {
    // Sign up and then sign out
    await signUpUser(page)
    
    await page.getByRole('button', { name: /User menu/i }).click()
    await page.getByRole('menuitem', { name: 'Sign Out' }).click()
    await page.waitForSelector('text=Sign in to your account', { timeout: 5000 })
    
    // Try to access a protected route
    await page.goto(`${WEB_URL}/projects`)
    
    // Should be redirected back to login
    await expect(page.getByText('Sign in to your account or create a new one')).toBeVisible({ timeout: 5000 })
  })
})
