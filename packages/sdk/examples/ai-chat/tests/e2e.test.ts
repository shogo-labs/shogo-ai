/**
 * AI Chat E2E Tests
 * 
 * Tests core chat functionality including authentication, chat creation,
 * messaging, and chat management.
 */

import { test, expect, type Page } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3005'

// Generate unique email for each test run
function generateEmail() {
  return `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`
}

// Helper to ensure we're on the chat dashboard
async function ensureDashboard(page: Page, testEmail: string) {
  await page.goto(BASE_URL)
  await page.waitForLoadState('networkidle')
  
  // Check if we need to sign in
  const emailInput = page.locator('input[type="email"]')
  if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await emailInput.fill(testEmail)
    await page.click('button[type="submit"]')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
  }
  
  // Wait for dashboard to load
  await expect(page.getByRole('heading', { name: /AI Chat/i }).first()).toBeVisible({ timeout: 15000 })
}

test.describe('AI Chat', () => {
  test('shows auth page for unauthenticated users', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Should show auth form
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible()
    
    // Should show SDK branding
    await expect(page.getByText('@shogo-ai/sdk').first()).toBeVisible()
  })

  test('can sign in with email', async ({ page }) => {
    const testEmail = generateEmail()
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Fill in email
    const emailInput = page.locator('input[type="email"]')
    await emailInput.fill(testEmail)
    
    // Submit
    await page.click('button[type="submit"]')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    
    // Should see chat interface
    await expect(page.getByRole('heading', { name: /AI Chat/i }).first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: /new chat/i })).toBeVisible()
  })

  test('can create a new chat', async ({ page }) => {
    const testEmail = generateEmail()
    await ensureDashboard(page, testEmail)
    
    // Click new chat button
    await page.click('button:has-text("New Chat")')
    await page.waitForTimeout(500)
    
    // Chat should be created and visible in sidebar
    // The input should be focused
    await expect(page.locator('.message-input')).toBeVisible()
  })

  test('shows empty state when no chat selected', async ({ page }) => {
    const testEmail = generateEmail()
    await ensureDashboard(page, testEmail)
    
    // Should show empty state message
    await expect(page.getByText(/start a new conversation/i)).toBeVisible({ timeout: 10000 })
  })

  test('can type in the message input', async ({ page }) => {
    const testEmail = generateEmail()
    await ensureDashboard(page, testEmail)
    
    // Create a chat first
    await page.click('button:has-text("New Chat")')
    await page.waitForTimeout(500)
    
    // Type a message
    const input = page.locator('.message-input')
    await input.fill('Hello, AI!')
    
    // Send button should be enabled
    await expect(page.locator('.send-btn')).toBeEnabled()
  })

  test('displays user email in header', async ({ page }) => {
    const testEmail = generateEmail()
    await ensureDashboard(page, testEmail)
    
    // User badge should show an email address
    const badge = page.locator('.user-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('@example.com')
  })

  test('sidebar shows chat list', async ({ page }) => {
    const testEmail = generateEmail()
    await ensureDashboard(page, testEmail)
    
    // Sidebar should be visible
    await expect(page.locator('.sidebar')).toBeVisible()
    
    // New chat button should be visible
    await expect(page.getByRole('button', { name: /new chat/i })).toBeVisible()
  })

  test('can send a message and see response (demo mode)', async ({ page }) => {
    // Use unique email for this test
    const uniqueEmail = `chat-test-${Date.now()}@example.com`
    await ensureDashboard(page, uniqueEmail)
    
    // Create a chat
    await page.click('button:has-text("New Chat")')
    await page.waitForTimeout(500)
    
    // Type and send a message
    const input = page.locator('.message-input')
    await input.fill('Hello!')
    await page.click('.send-btn')
    
    // Should see user message
    await expect(page.locator('[data-role="user"]').first()).toBeVisible({ timeout: 10000 })
    
    // Should see assistant response (demo mode shows response about API key)
    await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 15000 })
  })

  test('message input clears after sending', async ({ page }) => {
    const uniqueEmail = `input-test-${Date.now()}@example.com`
    await ensureDashboard(page, uniqueEmail)
    
    // Create a chat
    await page.click('button:has-text("New Chat")')
    await page.waitForTimeout(500)
    
    // Type and send
    const input = page.locator('.message-input')
    await input.fill('Test message')
    await page.click('.send-btn')
    
    // Input should be cleared
    await expect(input).toHaveValue('')
  })

  test('can delete a chat', async ({ page }) => {
    const uniqueEmail = `delete-test-${Date.now()}@example.com`
    await ensureDashboard(page, uniqueEmail)
    
    // Create a chat
    await page.click('button:has-text("New Chat")')
    await page.waitForTimeout(1000)
    
    // Send a message to give it a title
    const input = page.locator('.message-input')
    await input.fill('Chat to delete')
    await page.click('.send-btn')
    await page.waitForTimeout(2000)
    
    // Find and click delete button on the chat item
    const chatItem = page.locator('.chat-item').first()
    await chatItem.hover()
    await page.click('.chat-item-delete')
    
    // Chat should be removed or empty state shown
    await expect(page.getByText(/start a new conversation/i)).toBeVisible({ timeout: 10000 })
  })

  test('chat title updates from first message', async ({ page }) => {
    const uniqueEmail = `title-test-${Date.now()}@example.com`
    await ensureDashboard(page, uniqueEmail)
    
    // Create a chat
    await page.click('button:has-text("New Chat")')
    await page.waitForTimeout(500)
    
    // Send a message
    const testMessage = 'This should become the title'
    const input = page.locator('.message-input')
    await input.fill(testMessage)
    await page.click('.send-btn')
    
    // Wait for response
    await page.waitForTimeout(2000)
    
    // Chat title in sidebar should reflect message
    await expect(page.locator('.chat-item-title').first()).toContainText(testMessage.slice(0, 20))
  })

  test('SDK attribution is visible', async ({ page }) => {
    const testEmail = generateEmail()
    await ensureDashboard(page, testEmail)
    
    // SDK attribution should be in footer
    await expect(page.locator('.sidebar-footer')).toContainText('@shogo-ai/sdk')
  })
})
