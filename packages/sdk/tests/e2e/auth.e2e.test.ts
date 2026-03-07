// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Auth E2E Tests
 *
 * Tests authentication flows using the todo-app example.
 */

import { test, expect } from '@playwright/test'
import { generateTestEmail, clearAuthState } from './setup'

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    // Clear auth state before each test
    await page.goto('/')
    await clearAuthState(page)
    await page.reload()
  })

  test('should show sign in form by default', async ({ page }) => {
    await page.goto('/')

    // Should see sign in form
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
    await expect(page.getByPlaceholder('Email')).toBeVisible()
    await expect(page.getByPlaceholder('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible()
  })

  test('should switch to sign up form', async ({ page }) => {
    await page.goto('/')

    // Click sign up link
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Should see sign up form
    await expect(page.getByRole('heading', { name: 'Create Account' })).toBeVisible()
    await expect(page.getByPlaceholder('Name (optional)')).toBeVisible()
    await expect(page.getByPlaceholder('Email')).toBeVisible()
    await expect(page.getByPlaceholder('Password')).toBeVisible()
  })

  test('should sign up a new user', async ({ page }) => {
    const email = generateTestEmail()
    const password = 'TestPassword123!'

    await page.goto('/')

    // Switch to sign up
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Fill form
    await page.getByPlaceholder('Name (optional)').fill('Test User')
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(password)

    // Submit
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Should be authenticated and see todo app
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(`Welcome, ${email}`)).toBeVisible()
  })

  test('should sign in an existing user', async ({ page }) => {
    const email = generateTestEmail()
    const password = 'TestPassword123!'

    // First, sign up
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign Up' }).click()
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Wait for authenticated state
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    // Sign out
    await page.getByRole('button', { name: 'Sign Out' }).click()

    // Should be back at sign in
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()

    // Now sign in
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByRole('button', { name: 'Sign In' }).click()

    // Should be authenticated again
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(`Welcome, ${email}`)).toBeVisible()
  })

  test('should show error for invalid credentials', async ({ page }) => {
    await page.goto('/')

    // Try to sign in with non-existent user
    await page.getByPlaceholder('Email').fill('nonexistent@example.com')
    await page.getByPlaceholder('Password').fill('wrongpassword')
    await page.getByRole('button', { name: 'Sign In' }).click()

    // Should show error
    await expect(page.getByText(/invalid|failed|error/i)).toBeVisible({ timeout: 5000 })
  })

  test('should sign out', async ({ page }) => {
    const email = generateTestEmail()
    const password = 'TestPassword123!'

    // Sign up first
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign Up' }).click()
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Wait for authenticated state
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    // Sign out
    await page.getByRole('button', { name: 'Sign Out' }).click()

    // Should be back at sign in form
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()
  })

  test('should persist session across page reload', async ({ page }) => {
    const email = generateTestEmail()
    const password = 'TestPassword123!'

    // Sign up
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign Up' }).click()
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Wait for authenticated state
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    // Reload the page
    await page.reload()

    // Should still be authenticated
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(`Welcome, ${email}`)).toBeVisible()
  })
})
