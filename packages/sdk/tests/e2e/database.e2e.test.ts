/**
 * Database E2E Tests
 *
 * Tests CRUD operations and query functionality using the todo-app example.
 */

import { test, expect } from '@playwright/test'
import { generateTestEmail, clearAuthState } from './setup'

test.describe('Database Operations', () => {
  let email: string
  const password = 'TestPassword123!'

  test.beforeAll(async ({ browser }) => {
    // Create a shared authenticated session for database tests
    email = generateTestEmail()
    const page = await browser.newPage()

    await page.goto('/')
    await clearAuthState(page)
    await page.reload()

    // Sign up
    await page.getByRole('button', { name: 'Sign Up' }).click()
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Wait for authenticated state
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    await page.close()
  })

  test.beforeEach(async ({ page }) => {
    // Sign in for each test
    await page.goto('/')
    await clearAuthState(page)
    await page.reload()

    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByRole('button', { name: 'Sign In' }).click()

    // Wait for authenticated state
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })
  })

  test('should create a new todo', async ({ page }) => {
    const todoTitle = `Test Todo ${Date.now()}`

    // Fill in the todo form
    await page.getByPlaceholder('What needs to be done?').fill(todoTitle)
    await page.getByRole('button', { name: 'Add' }).click()

    // Should see the new todo in the list
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })
  })

  test('should toggle todo completion', async ({ page }) => {
    const todoTitle = `Toggle Test ${Date.now()}`

    // Create a todo first
    await page.getByPlaceholder('What needs to be done?').fill(todoTitle)
    await page.getByRole('button', { name: 'Add' }).click()

    // Wait for it to appear
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })

    // Find the checkbox for this todo and click it
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    const checkbox = todoItem.getByRole('checkbox')
    await checkbox.click()

    // Verify it's checked (completed)
    await expect(checkbox).toBeChecked()

    // Click again to uncheck
    await checkbox.click()
    await expect(checkbox).not.toBeChecked()
  })

  test('should delete a todo', async ({ page }) => {
    const todoTitle = `Delete Test ${Date.now()}`

    // Create a todo first
    await page.getByPlaceholder('What needs to be done?').fill(todoTitle)
    await page.getByRole('button', { name: 'Add' }).click()

    // Wait for it to appear
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })

    // Find the delete button for this todo and click it
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    await todoItem.getByRole('button', { name: 'Delete' }).click()

    // Verify it's gone
    await expect(page.getByText(todoTitle)).not.toBeVisible({ timeout: 5000 })
  })

  test('should persist todos across page reload', async ({ page }) => {
    const todoTitle = `Persist Test ${Date.now()}`

    // Create a todo
    await page.getByPlaceholder('What needs to be done?').fill(todoTitle)
    await page.getByRole('button', { name: 'Add' }).click()

    // Wait for it to appear
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })

    // Reload the page
    await page.reload()

    // Should still be authenticated
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    // Todo should still be there
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })
  })

  test('should create multiple todos', async ({ page }) => {
    const todos = [
      `Multi Test A ${Date.now()}`,
      `Multi Test B ${Date.now()}`,
      `Multi Test C ${Date.now()}`,
    ]

    // Create multiple todos
    for (const title of todos) {
      await page.getByPlaceholder('What needs to be done?').fill(title)
      await page.getByRole('button', { name: 'Add' }).click()
      // Wait for each to appear before creating next
      await expect(page.getByText(title)).toBeVisible({ timeout: 5000 })
    }

    // Verify all are visible
    for (const title of todos) {
      await expect(page.getByText(title)).toBeVisible()
    }
  })

  test('should show empty state when no todos', async ({ page }) => {
    // This test uses a fresh user to ensure no todos exist
    const freshEmail = generateTestEmail()

    // Sign out current user
    await page.getByRole('button', { name: 'Sign Out' }).click()
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible()

    // Sign up as new user
    await page.getByRole('button', { name: 'Sign Up' }).click()
    await page.getByPlaceholder('Email').fill(freshEmail)
    await page.getByPlaceholder('Password').fill(password)
    await page.getByRole('button', { name: 'Sign Up' }).click()

    // Wait for authenticated state
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    // Should show empty state or have no todo items
    const todoList = page.locator('ul')
    const todoCount = await todoList.locator('li').count()
    expect(todoCount).toBe(0)
  })

  test('should handle rapid operations', async ({ page }) => {
    // Create several todos rapidly
    const baseName = `Rapid ${Date.now()}`

    for (let i = 0; i < 3; i++) {
      await page.getByPlaceholder('What needs to be done?').fill(`${baseName} - ${i}`)
      await page.getByRole('button', { name: 'Add' }).click()
    }

    // Wait for all to appear
    for (let i = 0; i < 3; i++) {
      await expect(page.getByText(`${baseName} - ${i}`)).toBeVisible({ timeout: 5000 })
    }

    // Verify count
    const todoList = page.locator('ul')
    const visibleTodos = todoList.locator('li').filter({ hasText: baseName })
    await expect(visibleTodos).toHaveCount(3)
  })
})

test.describe('User Data Isolation', () => {
  test('different users should have separate todos', async ({ browser }) => {
    const password = 'TestPassword123!'

    // User 1 creates a todo
    const user1Email = generateTestEmail()
    const user1TodoTitle = `User1 Todo ${Date.now()}`

    const page1 = await browser.newPage()
    await page1.goto('/')
    await clearAuthState(page1)
    await page1.reload()

    // Sign up user 1
    await page1.getByRole('button', { name: 'Sign Up' }).click()
    await page1.getByPlaceholder('Email').fill(user1Email)
    await page1.getByPlaceholder('Password').fill(password)
    await page1.getByRole('button', { name: 'Sign Up' }).click()
    await expect(page1.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    // Create todo for user 1
    await page1.getByPlaceholder('What needs to be done?').fill(user1TodoTitle)
    await page1.getByRole('button', { name: 'Add' }).click()
    await expect(page1.getByText(user1TodoTitle)).toBeVisible({ timeout: 5000 })

    await page1.close()

    // User 2 signs up and should NOT see user 1's todo
    const user2Email = generateTestEmail()
    const page2 = await browser.newPage()
    await page2.goto('/')
    await clearAuthState(page2)
    await page2.reload()

    // Sign up user 2
    await page2.getByRole('button', { name: 'Sign Up' }).click()
    await page2.getByPlaceholder('Email').fill(user2Email)
    await page2.getByPlaceholder('Password').fill(password)
    await page2.getByRole('button', { name: 'Sign Up' }).click()
    await expect(page2.getByRole('heading', { name: 'Todo App' })).toBeVisible({ timeout: 10000 })

    // User 2 should NOT see user 1's todo
    await expect(page2.getByText(user1TodoTitle)).not.toBeVisible()

    // Verify empty state for user 2
    const todoList = page2.locator('ul')
    const todoCount = await todoList.locator('li').count()
    expect(todoCount).toBe(0)

    await page2.close()
  })
})
