/**
 * Email Template System
 *
 * Simple template system using {{variable}} interpolation.
 * No dependencies - just string replacement.
 */

import type { EmailTemplate, TemplateRegistry } from './types.js'
import { EmailError } from './types.js'

/**
 * Interpolate variables into a template string.
 *
 * Replaces {{variableName}} with the corresponding value from data.
 * Supports nested access: {{user.name}} → data.user.name
 *
 * @param template - Template string with {{variable}} placeholders
 * @param data - Data object with values to interpolate
 * @returns Interpolated string
 */
export function interpolate(
  template: string,
  data: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const value = getNestedValue(data, path)
    return value !== undefined ? String(value) : match
  })
}

/**
 * Get a nested value from an object using dot notation.
 *
 * @param obj - Source object
 * @param path - Dot-separated path (e.g., "user.name")
 * @returns Value at path or undefined
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.')
  let current: unknown = obj

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }

  return current
}

/**
 * Strip HTML tags to create plain text version.
 *
 * @param html - HTML string
 * @returns Plain text string
 */
export function htmlToText(html: string): string {
  return html
    // Remove style and script tags with content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Convert common block elements to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Template registry class for managing email templates.
 */
export class EmailTemplateRegistry {
  private templates: TemplateRegistry = {}

  /**
   * Register a template
   */
  register<TData extends Record<string, unknown>>(
    template: EmailTemplate<TData>
  ): void {
    this.templates[template.name] = template
  }

  /**
   * Get a template by name
   */
  get(name: string): EmailTemplate | undefined {
    return this.templates[name]
  }

  /**
   * Check if a template exists
   */
  has(name: string): boolean {
    return name in this.templates
  }

  /**
   * Render a template with data
   */
  render<TData extends Record<string, unknown>>(
    name: string,
    data: TData
  ): { subject: string; html: string; text: string } {
    const template = this.templates[name]

    if (!template) {
      throw EmailError.templateNotFound(name)
    }

    // Merge defaults with provided data
    const mergedData = { ...template.defaults, ...data }

    // Add common variables
    const allData = {
      ...mergedData,
      currentYear: new Date().getFullYear(),
    }

    const subject = interpolate(template.subject, allData)
    const html = interpolate(template.html, allData)
    const text = template.text
      ? interpolate(template.text, allData)
      : htmlToText(html)

    return { subject, html, text }
  }

  /**
   * List all registered template names
   */
  list(): string[] {
    return Object.keys(this.templates)
  }
}

// ============================================================================
// Built-in Templates
// ============================================================================

/**
 * Built-in welcome email template
 */
export const welcomeTemplate: EmailTemplate<{
  name: string
  appName: string
  loginUrl?: string
}> = {
  name: 'welcome',
  subject: 'Welcome to {{appName}}!',
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="width: 100%; max-width: 600px; background: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px;">
              <h1 style="margin: 0 0 24px; font-size: 24px; color: #18181b;">
                Welcome to {{appName}}! 🎉
              </h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                Hi {{name}},
              </p>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                Thanks for signing up. We're excited to have you on board!
              </p>
              {{#if loginUrl}}
              <table role="presentation" style="margin: 32px 0;">
                <tr>
                  <td>
                    <a href="{{loginUrl}}" style="display: inline-block; padding: 12px 24px; background: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px;">
                      Get Started
                    </a>
                  </td>
                </tr>
              </table>
              {{/if}}
              <p style="margin: 24px 0 0; font-size: 14px; color: #71717a;">
                If you have any questions, just reply to this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background: #fafafa; border-top: 1px solid #e4e4e7; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; font-size: 13px; color: #a1a1aa; text-align: center;">
                © {{currentYear}} {{appName}}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  defaults: {
    appName: 'Our App',
  },
}

/**
 * Built-in password reset email template
 */
export const passwordResetTemplate: EmailTemplate<{
  name?: string
  appName: string
  resetUrl: string
  expiresIn?: string
}> = {
  name: 'password-reset',
  subject: 'Reset your {{appName}} password',
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="width: 100%; max-width: 600px; background: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px;">
              <h1 style="margin: 0 0 24px; font-size: 24px; color: #18181b;">
                Reset Your Password
              </h1>
              <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                {{#if name}}Hi {{name}},{{/if}}
              </p>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                We received a request to reset your password. Click the button below to choose a new one:
              </p>
              <table role="presentation" style="margin: 32px 0;">
                <tr>
                  <td>
                    <a href="{{resetUrl}}" style="display: inline-block; padding: 12px 24px; background: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 16px 0; font-size: 14px; color: #71717a;">
                This link will expire in {{expiresIn}}.
              </p>
              <p style="margin: 24px 0 0; font-size: 14px; color: #71717a;">
                If you didn't request this, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background: #fafafa; border-top: 1px solid #e4e4e7; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; font-size: 13px; color: #a1a1aa; text-align: center;">
                © {{currentYear}} {{appName}}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  defaults: {
    appName: 'Our App',
    expiresIn: '1 hour',
  },
}

/**
 * Built-in invitation email template
 */
export const invitationTemplate: EmailTemplate<{
  inviterName: string
  resourceName: string
  resourceType?: string
  role?: string
  acceptUrl: string
  appName: string
}> = {
  name: 'invitation',
  subject: '{{inviterName}} invited you to join {{resourceName}}',
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="width: 100%; max-width: 600px; background: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px;">
              <h1 style="margin: 0 0 24px; font-size: 24px; color: #18181b;">
                You're Invited! 🎉
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                <strong>{{inviterName}}</strong> has invited you to join 
                <strong>{{resourceName}}</strong>{{#if role}} as a <strong>{{role}}</strong>{{/if}}.
              </p>
              <table role="presentation" style="margin: 32px 0;">
                <tr>
                  <td>
                    <a href="{{acceptUrl}}" style="display: inline-block; padding: 12px 24px; background: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px;">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0; font-size: 14px; color: #71717a;">
                If you weren't expecting this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background: #fafafa; border-top: 1px solid #e4e4e7; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; font-size: 13px; color: #a1a1aa; text-align: center;">
                © {{currentYear}} {{appName}}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  defaults: {
    appName: 'Our App',
    resourceType: 'workspace',
  },
}

/**
 * Built-in notification email template
 */
export const notificationTemplate: EmailTemplate<{
  title: string
  message: string
  actionUrl?: string
  actionText?: string
  appName: string
}> = {
  name: 'notification',
  subject: '{{title}}',
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="width: 100%; max-width: 600px; background: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px;">
              <h1 style="margin: 0 0 24px; font-size: 24px; color: #18181b;">
                {{title}}
              </h1>
              <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #3f3f46;">
                {{message}}
              </p>
              {{#if actionUrl}}
              <table role="presentation" style="margin: 32px 0;">
                <tr>
                  <td>
                    <a href="{{actionUrl}}" style="display: inline-block; padding: 12px 24px; background: #6366f1; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px;">
                      {{actionText}}
                    </a>
                  </td>
                </tr>
              </table>
              {{/if}}
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background: #fafafa; border-top: 1px solid #e4e4e7; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; font-size: 13px; color: #a1a1aa; text-align: center;">
                © {{currentYear}} {{appName}}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  defaults: {
    appName: 'Our App',
    actionText: 'View Details',
  },
}

/**
 * All built-in templates
 */
export const builtinTemplates: EmailTemplate[] = [
  welcomeTemplate,
  passwordResetTemplate,
  invitationTemplate,
  notificationTemplate,
]

/**
 * Create a template registry with built-in templates pre-registered
 */
export function createTemplateRegistry(): EmailTemplateRegistry {
  const registry = new EmailTemplateRegistry()

  for (const template of builtinTemplates) {
    registry.register(template)
  }

  return registry
}
