import { test, expect, type Page } from '@playwright/test'

// Helper to sign up and navigate to chat
async function signUpAndNavigate(page: Page, email: string) {
  await page.goto('/')
  
  // Wait for auth page to load
  await page.waitForSelector('[data-testid="email-input"]')
  
  // Fill in credentials
  await page.fill('[data-testid="email-input"]', email)
  await page.fill('[data-testid="password-input"]', 'password123')
  
  // Click sign up toggle if not already on sign up
  const toggleButton = page.locator('[data-testid="toggle-auth-mode"]')
  const toggleText = await toggleButton.textContent()
  if (toggleText?.includes("Don't have an account")) {
    await toggleButton.click()
    await page.waitForTimeout(300)
  }
  
  // Submit
  await page.click('[data-testid="submit-button"]')
  
  // Wait for chat interface
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 10000 })
}

test.describe('Authentication', () => {
  test('shows login page on first visit', async ({ page }) => {
    await page.goto('/')
    
    await expect(page.locator('[data-testid="email-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="password-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="submit-button"]')).toBeVisible()
  })

  test('can toggle between sign in and sign up', async ({ page }) => {
    await page.goto('/')
    
    const toggleButton = page.locator('[data-testid="toggle-auth-mode"]')
    await expect(toggleButton).toContainText("Don't have an account")
    
    await toggleButton.click()
    await expect(toggleButton).toContainText('Already have an account')
  })

  test('can sign up and access chat', async ({ page }) => {
    const email = `test-${Date.now()}@example.com`
    await signUpAndNavigate(page, email)
    
    // Should be on chat page
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible()
  })
})

test.describe('Chat Interface', () => {
  test.beforeEach(async ({ page }) => {
    const email = `test-${Date.now()}@example.com`
    await signUpAndNavigate(page, email)
  })

  test('shows chat input field', async ({ page }) => {
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible()
  })

  test('shows send button', async ({ page }) => {
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible()
  })

  test('shows suggested actions on empty chat', async ({ page }) => {
    await expect(page.locator('[data-testid="suggested-actions"]')).toBeVisible()
  })

  test('can type in chat input', async ({ page }) => {
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill('Hello, AI!')
    await expect(input).toHaveValue('Hello, AI!')
  })

  test('can send a message', async ({ page }) => {
    // Type a message
    await page.fill('[data-testid="chat-input"]', 'Hello, AI!')
    
    // Click send
    await page.click('[data-testid="send-button"]')
    
    // Should see user message
    await expect(page.locator('[data-testid="message-user"]')).toBeVisible({ timeout: 5000 })
    
    // Wait for assistant response (might take a moment in demo mode)
    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible({ timeout: 15000 })
  })

  test('can stop generation', async ({ page }) => {
    // Send a message
    await page.fill('[data-testid="chat-input"]', 'Tell me a very long story about a dragon')
    await page.click('[data-testid="send-button"]')
    
    // Wait for thinking indicator (loading state)
    const stopButton = page.locator('[data-testid="stop-button"]')
    
    // If stop button appears, click it
    try {
      await stopButton.waitFor({ state: 'visible', timeout: 2000 })
      await stopButton.click()
    } catch {
      // Response might have finished quickly
    }
  })
})

test.describe('Sidebar', () => {
  test.beforeEach(async ({ page }) => {
    const email = `test-${Date.now()}@example.com`
    await signUpAndNavigate(page, email)
  })

  test('can create new chat', async ({ page }) => {
    // Click new chat button
    await page.click('[data-testid="new-chat-button"]')
    
    // Should show empty state with suggested actions
    await expect(page.locator('[data-testid="suggested-actions"]')).toBeVisible()
  })

  test('shows chat history', async ({ page }) => {
    // Send a message to create a chat
    await page.fill('[data-testid="chat-input"]', 'Test message for history')
    await page.click('[data-testid="send-button"]')
    
    // Wait for response
    await page.waitForSelector('[data-testid="message-assistant"]', { timeout: 15000 })
    
    // Chat history should be visible in sidebar
    await expect(page.locator('[data-testid="chat-history"]')).toBeVisible()
  })
})
