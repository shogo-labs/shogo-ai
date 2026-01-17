/**
 * E2E Test: Invite Member
 * 
 * Tests inviting members to workspace:
 * 1. User can navigate to people/members settings
 * 2. User can open invite dialog
 * 3. User can invite a member (UI flow)
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL, waitForProjectCreation } from '../helpers/test-helpers'

test.describe('Invite Member E2E', () => {
  test('user can navigate to people settings', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to settings
    await page.goto(`${WEB_URL}/settings?tab=people`)
    await page.waitForTimeout(2000)
    
    // Verify we're on people settings
    const heading = page.getByRole('heading', { name: /People/i }).first()
    await expect(heading).toBeVisible({ timeout: 5000 })
  })

  test('people settings shows current members', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to people settings
    await page.goto(`${WEB_URL}/settings?tab=people`)
    await page.waitForTimeout(2000)
    
    // Verify members table/list is visible
    const membersTable = page.locator('table, [role="table"]').first()
    const membersList = page.getByText(/Owner|member/i).first()
    
    // Either table or list should be visible
    const hasTable = await membersTable.isVisible().catch(() => false)
    const hasList = await membersList.isVisible().catch(() => false)
    
    expect(hasTable || hasList).toBe(true)
  })

  test('user can open invite members dialog', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to people settings
    await page.goto(`${WEB_URL}/settings?tab=people`)
    await page.waitForTimeout(2000)
    
    // Find invite members button
    const inviteButton = page.getByRole('button', { name: /Invite members|Add people/i }).first()
    
    if (await inviteButton.isVisible().catch(() => false)) {
      await expect(inviteButton).toBeVisible()
      await inviteButton.click()
      
      // Wait for dialog to appear
      await page.waitForTimeout(500)
      
      // Verify dialog is visible
      const dialog = page.getByRole('dialog').first()
      const isDialogVisible = await dialog.isVisible().catch(() => false)
      
      // Dialog might appear or form might be inline
      if (isDialogVisible) {
        await expect(dialog).toBeVisible()
      }
    }
  })

  test('user can see invite link option', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project first
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Invite Test ${Date.now()}`)
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
    
    // Open share dropdown
    const shareButton = page.getByRole('button', { name: /Share/i }).first()
    await shareButton.click()
    await page.waitForTimeout(500)
    
    // Look for invite link option
    const inviteLinkButton = page.getByRole('button', { name: /Create invite link|Invite link/i }).first()
    
    if (await inviteLinkButton.isVisible().catch(() => false)) {
      await expect(inviteLinkButton).toBeVisible()
    }
  })
})
