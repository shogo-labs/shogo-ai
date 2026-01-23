/**
 * Todo App E2E Tests
 *
 * Tests the Shogo SDK functionality:
 * - User creation via shogo.db
 * - Todo CRUD operations
 * - MobX optimistic updates
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

test.describe('Todo App - Shogo SDK Example', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any existing data by navigating to the app
    await page.goto(BASE_URL)
  })

  test('should display the setup form', async ({ page }) => {
    await page.goto(BASE_URL)

    // App title should be visible
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible()

    // Should show setup form with email input
    await expect(page.getByPlaceholder('Email address')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Get Started' })).toBeVisible()
  })

  test('should show SDK attribution', async ({ page }) => {
    await page.goto(BASE_URL)

    // Should mention shogo.db
    await expect(page.getByText('shogo.db')).toBeVisible()
  })

  test('should create user and show todo list', async ({ page }) => {
    await page.goto(BASE_URL)

    const testEmail = `test-${Date.now()}@example.com`

    // Fill in the setup form
    await page.getByPlaceholder('Email address').fill(testEmail)
    await page.getByPlaceholder('Name (optional)').fill('E2E Test User')

    // Click Get Started
    await page.getByRole('button', { name: 'Get Started' }).click()

    // Should transition to todo list
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({
      timeout: 10000,
    })

    // Should show user info
    await expect(page.getByText('E2E Test User')).toBeVisible()
  })

  test('should add a todo', async ({ page }) => {
    await page.goto(BASE_URL)

    // Create user first
    const testEmail = `test-${Date.now()}@example.com`
    await page.getByPlaceholder('Email address').fill(testEmail)
    await page.getByRole('button', { name: 'Get Started' }).click()
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({
      timeout: 10000,
    })

    // Add a todo
    const todoTitle = `E2E Todo ${Date.now()}`
    await page.getByPlaceholder('What needs to be done?').fill(todoTitle)
    await page.getByRole('button', { name: 'Add' }).click()

    // Todo should appear
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })
  })

  test('should toggle a todo', async ({ page }) => {
    await page.goto(BASE_URL)

    // Create user and add a todo
    const testEmail = `test-${Date.now()}@example.com`
    await page.getByPlaceholder('Email address').fill(testEmail)
    await page.getByRole('button', { name: 'Get Started' }).click()
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({
      timeout: 10000,
    })

    const todoTitle = `Toggle ${Date.now()}`
    await page.getByPlaceholder('What needs to be done?').fill(todoTitle)
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })

    // Find and click the checkbox
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    const checkbox = todoItem.getByRole('checkbox')

    // Toggle it
    await checkbox.click()

    // Should be checked
    await expect(checkbox).toBeChecked({ timeout: 5000 })
  })

  test('should delete a todo', async ({ page }) => {
    await page.goto(BASE_URL)

    // Create user and add a todo
    const testEmail = `test-${Date.now()}@example.com`
    await page.getByPlaceholder('Email address').fill(testEmail)
    await page.getByRole('button', { name: 'Get Started' }).click()
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({
      timeout: 10000,
    })

    const todoTitle = `Delete ${Date.now()}`
    await page.getByPlaceholder('What needs to be done?').fill(todoTitle)
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })

    // Find and click delete
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    await todoItem.getByRole('button', { name: 'Delete' }).click()

    // Should be gone
    await expect(page.getByText(todoTitle)).not.toBeVisible({ timeout: 5000 })
  })

  test('should show todo stats', async ({ page }) => {
    await page.goto(BASE_URL)

    // Create user
    const testEmail = `test-${Date.now()}@example.com`
    await page.getByPlaceholder('Email address').fill(testEmail)
    await page.getByRole('button', { name: 'Get Started' }).click()
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({
      timeout: 10000,
    })

    // Add two todos
    await page.getByPlaceholder('What needs to be done?').fill('First todo')
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText('First todo')).toBeVisible()

    await page.getByPlaceholder('What needs to be done?').fill('Second todo')
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText('Second todo')).toBeVisible()

    // Check stats
    await expect(page.getByText('2 pending')).toBeVisible()

    // Toggle one
    const firstTodo = page.locator('li').filter({ hasText: 'First todo' })
    await firstTodo.getByRole('checkbox').click()

    // Stats should update
    await expect(page.getByText('1 pending')).toBeVisible()
    await expect(page.getByText('1 completed')).toBeVisible()
  })
})
