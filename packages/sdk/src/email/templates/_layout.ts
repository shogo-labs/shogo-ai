/**
 * Shared Shogo email layout.
 * All templates wrap their content with this layout for consistent branding.
 * Uses <style> block with CSS classes — no inline styles.
 */

export const EMAIL_CONSTANTS = {
  APP_NAME: 'Shogo',
  APP_URL: 'https://shogo.ai',
  SUPPORT_EMAIL: 'support@shogo.ai',
  FOOTER_TEXT: '&copy; {{currentYear}} Shogo AI &middot; All rights reserved',
} as const

const STYLES = `
<style>
  body, html { margin: 0; padding: 0; }
  .email-body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background-color: #f4f4f5;
    color: #18181b;
    line-height: 1.6;
  }
  .email-wrapper { padding: 40px 20px; }
  .email-container {
    max-width: 560px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  .email-header {
    background: #18181b;
    padding: 24px 32px;
    text-align: left;
  }
  .email-logo {
    font-size: 18px;
    font-weight: 700;
    color: #ffffff;
    text-decoration: none;
    letter-spacing: -0.3px;
  }
  .email-content { padding: 32px; }
  .email-h1 {
    font-size: 22px;
    font-weight: 700;
    color: #18181b;
    margin: 0 0 16px;
  }
  .email-text {
    font-size: 15px;
    color: #3f3f46;
    margin: 0 0 16px;
  }
  .email-muted {
    font-size: 13px;
    color: #71717a;
    margin: 0 0 12px;
  }
  .email-btn {
    display: inline-block;
    padding: 12px 28px;
    background: #6366f1;
    color: #ffffff;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    border-radius: 8px;
    margin: 8px 0 16px;
  }
  .email-btn-outline {
    display: inline-block;
    padding: 12px 28px;
    background: #ffffff;
    color: #18181b;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    border-radius: 8px;
    border: 1px solid #d4d4d8;
    margin: 8px 0 16px;
  }
  .email-btn-danger {
    display: inline-block;
    padding: 12px 28px;
    background: #ef4444;
    color: #ffffff;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    border-radius: 8px;
    margin: 8px 0 16px;
  }
  .email-divider {
    border: none;
    border-top: 1px solid #e4e4e7;
    margin: 24px 0;
  }
  .email-footer {
    padding: 20px 32px;
    background: #fafafa;
    border-top: 1px solid #e4e4e7;
    text-align: center;
  }
  .email-footer-text {
    font-size: 12px;
    color: #a1a1aa;
    margin: 0;
  }
  .email-badge {
    display: inline-block;
    padding: 4px 10px;
    background: #f0f0ff;
    color: #6366f1;
    font-size: 12px;
    font-weight: 600;
    border-radius: 4px;
  }
  .email-detail-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #f4f4f5;
  }
  .email-detail-label {
    font-size: 13px;
    color: #71717a;
  }
  .email-detail-value {
    font-size: 13px;
    font-weight: 600;
    color: #18181b;
  }
</style>`

export function wrapInLayout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${STYLES}
</head>
<body class="email-body">
  <div class="email-wrapper">
    <div class="email-container">
      <div class="email-header">
        <a href="${EMAIL_CONSTANTS.APP_URL}" class="email-logo">${EMAIL_CONSTANTS.APP_NAME}</a>
      </div>
      <div class="email-content">
        ${content}
      </div>
      <div class="email-footer">
        <p class="email-footer-text">&copy; {{currentYear}} Shogo AI &middot; All rights reserved</p>
      </div>
    </div>
  </div>
</body>
</html>`
}
