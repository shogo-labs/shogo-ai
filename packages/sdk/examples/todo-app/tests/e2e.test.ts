/**
 * Todo App E2E Tests
 * 
 * Tests the Shogo SDK Prisma pass-through functionality:
 * - shogo.db.user.create() - User creation
 * - shogo.db.todo.create() - Todo creation
 * - shogo.db.todo.update() - Toggle completion
 * - shogo.db.todo.delete() - Todo deletion
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

test.describe('Todo App - Shogo SDK Example', () => {
  
  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // App title should be visible
    await expect(page.getByRole('heading', { name: 'Todo App' })).toBeVisible()
    
    // Should show either setup form or todo list
    const setupForm = page.getByPlaceholder('Email address')
    const todoInput = page.getByPlaceholder('What needs to be done?')
    
    const hasSetupForm = await setupForm.isVisible().catch(() => false)
    const hasTodoList = await todoInput.isVisible().catch(() => false)
    
    expect(hasSetupForm || hasTodoList).toBe(true)
  })

  test('should show SDK attribution', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Should mention shogo.db somewhere
    await expect(page.getByText('shogo.db')).toBeVisible()
  })

  test('should create user if on setup form', async ({ page }) => {
    await page.goto(BASE_URL)
    
    const setupForm = page.getByPlaceholder('Email address')
    const isSetup = await setupForm.isVisible().catch(() => false)
    
    if (isSetup) {
      const testEmail = `test-${Date.now()}@example.com`
      await setupForm.fill(testEmail)
      
      const nameInput = page.getByPlaceholder('Name (optional)')
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('E2E User')
      }
      
      await page.getByRole('button', { name: 'Get Started' }).click()
      
      // Should transition to todo list
      await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({ timeout: 10000 })
    }
  })

  test('should add a todo', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // If on setup, create user first
    const setupForm = page.getByPlaceholder('Email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({ timeout: 10000 })
    }
    
    // Add a todo
    const todoTitle = `E2E Todo ${Date.now()}`
    const input = page.getByPlaceholder('What needs to be done?')
    await input.click()
    await input.pressSequentially(todoTitle, { delay: 10 })
    // Submit with Enter key (works with controlled inputs)
    await input.press('Enter')
    
    // Todo should appear
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })
  })

  test('should toggle a todo', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Ensure we're on the todo list
    const setupForm = page.getByPlaceholder('Email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({ timeout: 10000 })
    }
    
    // Add a todo to toggle
    const todoTitle = `Toggle ${Date.now()}`
    const input = page.getByPlaceholder('What needs to be done?')
    await input.click()
    await input.pressSequentially(todoTitle, { delay: 10 })
    await input.press('Enter')
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })
    
    // Find and click the checkbox for our todo
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    const checkbox = todoItem.getByRole('checkbox')
    
    // Toggle it
    await checkbox.click()
    
    // Should be checked
    await expect(checkbox).toBeChecked({ timeout: 5000 })
  })

  test('should delete a todo', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Ensure we're on the todo list
    const setupForm = page.getByPlaceholder('Email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({ timeout: 10000 })
    }
    
    // Add a todo to delete
    const todoTitle = `Delete ${Date.now()}`
    const input = page.getByPlaceholder('What needs to be done?')
    await input.click()
    await input.pressSequentially(todoTitle, { delay: 10 })
    await input.press('Enter')
    await expect(page.getByText(todoTitle)).toBeVisible({ timeout: 5000 })
    
    // Find and click delete for our todo
    const todoItem = page.locator('li').filter({ hasText: todoTitle })
    await todoItem.getByRole('button', { name: 'Delete' }).click()
    
    // Should be gone
    await expect(page.getByText(todoTitle)).not.toBeVisible({ timeout: 5000 })
  })
})
