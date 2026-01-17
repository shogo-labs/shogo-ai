/**
 * SMTP Email Service Integration Tests
 *
 * Tests real email sending via AWS SES.
 * Requires SMTP_* environment variables to be configured.
 */

import { describe, test, expect } from "bun:test"
import { SmtpEmailService, createSmtpEmailServiceFromEnv } from "../smtp"
import { renderInvitationEmail } from "../templates"

// Skip tests if SMTP is not configured
const smtpConfigured = !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_PORT &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASSWORD &&
  process.env.SMTP_FROM_EMAIL
)

describe.skipIf(!smtpConfigured)("SmtpEmailService Integration", () => {
  test("createSmtpEmailServiceFromEnv returns configured service", () => {
    const service = createSmtpEmailServiceFromEnv()
    expect(service).not.toBeNull()
    expect(service!.isConfigured()).toBe(true)
  })

  test("can send a test email", async () => {
    const service = createSmtpEmailServiceFromEnv()!

    const result = await service.sendEmail({
      to: process.env.SMTP_FROM_EMAIL!, // Send to ourselves for testing
      subject: "Shogo AI - SMTP Test",
      html: "<h1>SMTP Test</h1><p>If you receive this, SMTP is working correctly!</p>",
    })

    console.log("Email result:", result)

    // Note: Even with valid credentials, SES sandbox mode may reject
    // emails to unverified addresses. Check the error message.
    if (!result.success) {
      console.warn("Email send failed:", result.error)
      // Don't fail the test if it's a sandbox/verification issue
      if (result.error?.includes("not verified") || result.error?.includes("sandbox")) {
        console.warn("SES is likely in sandbox mode - email address not verified")
        return
      }
    }

    expect(result.success).toBe(true)
    expect(result.messageId).toBeDefined()
  })

  test("can render and send invitation email", async () => {
    const service = createSmtpEmailServiceFromEnv()!

    const html = renderInvitationEmail({
      workspaceName: "Test Workspace",
      inviterName: "Test User",
      role: "member",
      acceptUrl: "https://shogo.ai/accept?token=test123",
    })

    expect(html).toContain("Test Workspace")
    expect(html).toContain("Test User")
    expect(html).toContain("member")

    const result = await service.sendEmail({
      to: process.env.SMTP_FROM_EMAIL!,
      subject: "Shogo AI - Invitation Test",
      html,
    })

    console.log("Invitation email result:", result)

    if (!result.success && (result.error?.includes("not verified") || result.error?.includes("sandbox"))) {
      console.warn("SES sandbox mode - skipping assertion")
      return
    }

    expect(result.success).toBe(true)
  })
})

describe("Email Templates", () => {
  test("renderInvitationEmail produces valid HTML", () => {
    const html = renderInvitationEmail({
      workspaceName: "My Workspace",
      inviterName: "John Doe",
      role: "admin",
      acceptUrl: "https://example.com/accept",
    })

    expect(html).toContain("My Workspace")
    expect(html).toContain("John Doe")
    expect(html).toContain("admin")
    expect(html).toContain("https://example.com/accept")
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("</html>")
  })

  test("renderInvitationEmail includes current year", () => {
    const html = renderInvitationEmail({
      workspaceName: "Test",
      inviterName: "Test",
      role: "member",
      acceptUrl: "https://example.com",
    })

    const currentYear = new Date().getFullYear().toString()
    expect(html).toContain(currentYear)
  })
})
