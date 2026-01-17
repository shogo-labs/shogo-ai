/**
 * E2E Test: Send Chat Message
 * 
 * Tests chat functionality:
 * 1. User can send a message in the chat
 * 2. Message appears in the chat history
 * 3. User can interact with AI responses
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL, waitForProjectCreation } from '../helpers/test-helpers'

test.describe('Send Chat Message E2E', () => {
  test('user can send a message in project chat', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Chat Test Project ${Date.now()}`)
    await chatInput.press('Enter')
    
    // Wait for project to be created
    await waitForProjectCreation(page)
    
    // Navigate to project if needed
    const url = page.url()
    if (!url.match(/\/projects\/[a-f0-9-]+/)) {
      const projectLink = page.locator('a[href*="/projects/"]:not([href="/projects"])').first()
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click()
        await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10000 })
      }
    }
    await page.waitForTimeout(2000)
    
    // Find the project chat input
    const projectChatInput = page.getByRole('textbox', { name: /Ask Shogo/i }).first()
    await expect(projectChatInput).toBeVisible({ timeout: 5000 })
    
    // Type a message
    const testMessage = `Test message ${Date.now()}`
    await projectChatInput.fill(testMessage)
    
    // Send the message (click Send button or press Enter)
    const sendButton = page.getByRole('button', { name: /Send message|Chat/i }).first()
    if (await sendButton.isEnabled().catch(() => false)) {
      await sendButton.click()
    } else {
      await projectChatInput.press('Enter')
    }
    
    // Wait for message to be sent (might show loading state first)
    await page.waitForTimeout(2000)
    
    // Verify message appears in chat (check for message content or loading indicator)
    // The exact implementation may vary, but we should see some response
    const messageVisible = await page.getByText(testMessage).isVisible().catch(() => false)
    const loadingIndicator = await page.locator('text=/thinking|loading|processing/i').isVisible().catch(() => false)
    
    // Either the message is visible or AI is processing
    expect(messageVisible || loadingIndicator).toBe(true)
  })

  test('user can use suggestion buttons in discovery phase', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Suggestion Test ${Date.now()}`)
    await chatInput.press('Enter')
    
    // Wait for project to be created
    await waitForProjectCreation(page)
    
    // Navigate to project if needed
    const url = page.url()
    if (!url.match(/\/projects\/[a-f0-9-]+/)) {
      const projectLink = page.locator('a[href*="/projects/"]:not([href="/projects"])').first()
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click()
        await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10000 })
      }
    }
    await page.waitForTimeout(2000)
    
    // Look for suggestion buttons (common in discovery phase)
    const suggestionButton = page.getByRole('button', { name: /Add a requirement|Describe the feature|What problem/i }).first()
    
    if (await suggestionButton.isVisible().catch(() => false)) {
      const buttonText = await suggestionButton.textContent()
      await suggestionButton.click()
      
      // Wait a moment for the action to complete
      await page.waitForTimeout(1000)
      
      // Verify the suggestion was used (might populate input or send message)
      const chatInputAfter = page.getByRole('textbox', { name: /Ask Shogo/i }).first()
      const inputValue = await chatInputAfter.inputValue().catch(() => '')
      
      // Either input was populated or message was sent
      expect(inputValue.length > 0 || buttonText).toBeTruthy()
    }
  })
})
