/**
 * Todo App E2E Tests
 *
 * Tests the Shogo SDK functionality:
 * - User creation via generated server functions
 * - Todo CRUD operations with auto-generated domain stores
 * - MobX optimistic updates
 */

import { test, expect, type Page } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

/**
 * Helper to ensure we're on the todo list view
 * Either by having an existing user or by creating one
 */
async function ensureTodoListView(page: Page, testName: string) {
  await page.goto(BASE_URL)
  
  // Check if we're on the todo list or login form
  const todoInput = page.getByPlaceholder('What needs to be done?')
  const emailInput = page.getByPlaceholder('Email address')
  
  // Wait for either the todo list or login form to be visible
  const isTodoList = await todoInput.isVisible({ timeout: 5000 }).catch(() => false)
  
  if (isTodoList) {
    // Already on todo list - user is signed in
    return
  }
  
  // Need to sign up a new user
  // Switch to signup mode if not already there
  const signUpLink = page.getByRole('button', { name: 'Sign up' })
  if (await signUpLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await signUpLink.click()
  }
  
  const testEmail = `test-${testName}-${Date.now()}@example.com`
  await page.getByPlaceholder('Name (optional)').fill('E2E Test User')
  await emailInput.fill(testEmail)
  await page.getByPlaceholder('Password').fill('test1234')
  await page.getByRole('button', { name: 'Create Account' }).click()
  
  // Wait for todo list to appear
  await expect(todoInput).toBeVisible({ timeout: 10000 })
}

/**
 * Helper to add a todo with proper waiting
 */
async function addTodo(page: Page, title: string) {
  const todoInput = page.getByPlaceholder('What needs to be done?')
  const addButton = page.getByRole('button', { name: 'Add' })
  
  // Focus and type into input
  await todoInput.click()
  await todoInput.fill(title)
  
  // Wait for button to be enabled (React state update)
  await expect(addButton).toBeEnabled({ timeout: 2000 })
  
  // Click add
  await addButton.click()
  
  // Wait for todo to appear
  await expect(page.getByText(title)).toBeVisible({ timeout: 5000 })
}

test.describe('Todo App - Shogo SDK Example', () => {
  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)

    // App title should be visible
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible()
  })

  test('should show SDK attribution', async ({ page }) => {
    await page.goto(BASE_URL)

    // Should mention @shogo-ai/sdk
    await expect(page.getByText('@shogo-ai/sdk')).toBeVisible()
  })

  test('should handle user setup or existing user', async ({ page }) => {
    await page.goto(BASE_URL)

    // Wait for either login form or todo list
    const todoInput = page.getByPlaceholder('What needs to be done?')
    const emailInput = page.getByPlaceholder('Email address')
    
    // One of these should be visible
    const isTodoList = await todoInput.isVisible({ timeout: 5000 }).catch(() => false)
    const isLoginForm = await emailInput.isVisible({ timeout: 1000 }).catch(() => false)
    
    expect(isTodoList || isLoginForm).toBeTruthy()
    
    // If login form, sign up a new user
    if (isLoginForm) {
      // Switch to signup mode
      const signUpLink = page.getByRole('button', { name: 'Sign up' })
      if (await signUpLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        await signUpLink.click()
      }
      
      const testEmail = `test-${Date.now()}@example.com`
      await page.getByPlaceholder('Name (optional)').fill('E2E Test User')
      await emailInput.fill(testEmail)
      await page.getByPlaceholder('Password').fill('test1234')
      await page.getByRole('button', { name: 'Create Account' }).click()
      
      // Should transition to todo list
      await expect(todoInput).toBeVisible({ timeout: 10000 })
    }
    
    // Should show user info - just check for Sign Out button to confirm we're logged in
    await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible()
  })

  test('should add a todo', async ({ page }) => {
    await ensureTodoListView(page, 'add')

    // Add a todo
    const todoTitle = `E2E Todo ${Date.now()}`
    await addTodo(page, todoTitle)

    // Todo should appear (already checked in addTodo)
  })

  test('should toggle a todo', async ({ page }) => {
    await ensureTodoListView(page, 'toggle')

    // Add a todo first
    const todoTitle = `Toggle ${Date.now()}`
    await addTodo(page, todoTitle)

    // Find and click the checkbox
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    const checkbox = todoItem.getByRole('checkbox')

    // Toggle it
    await checkbox.click()

    // Should be checked
    await expect(checkbox).toBeChecked({ timeout: 5000 })
  })

  test('should delete a todo', async ({ page }) => {
    await ensureTodoListView(page, 'delete')

    // Add a todo first
    const todoTitle = `Delete ${Date.now()}`
    await addTodo(page, todoTitle)

    // Find and click delete
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    await todoItem.getByRole('button', { name: 'Delete' }).click()

    // Should be gone
    await expect(page.getByText(todoTitle)).not.toBeVisible({ timeout: 5000 })
  })

  test('should show todo stats', async ({ page }) => {
    await ensureTodoListView(page, 'stats')

    // Add two todos with unique names
    const timestamp = Date.now()
    const todo1 = `Stats A ${timestamp}`
    const todo2 = `Stats B ${timestamp}`
    await addTodo(page, todo1)
    await addTodo(page, todo2)

    // Check stats (at least 2 pending now - there may be more from other tests)
    await expect(page.getByText(/\d+ pending/)).toBeVisible()

    // Toggle one
    const firstTodo = page.locator('li').filter({ hasText: todo1 })
    await firstTodo.getByRole('checkbox').click()

    // Stats should show completed
    await expect(page.getByText(/\d+ completed/)).toBeVisible()
  })
})
