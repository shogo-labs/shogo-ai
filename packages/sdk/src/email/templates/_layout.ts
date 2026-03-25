// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Shogo email layout.
 * All templates wrap their content with this layout for consistent branding.
 * Uses <style> block with CSS classes — no inline styles.
 */

export const EMAIL_CONSTANTS = {
  APP_NAME: 'Shogo',
  APP_URL: 'https://shogo.ai',
  SUPPORT_EMAIL: 'support@shogo.ai',
  LOGO_URL: 'https://shogo.ai/assets/images/shogo-logo-email.png',
  FOOTER_TEXT: '&copy; {{currentYear}} Shogo. All rights reserved',
} as const

const LIGHT_STYLES = `
  body, html { margin: 0; padding: 0; }
  .email-body {
    font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background-color: #fafafa;
    color: #2a2929;
    line-height: 1.6;
  }
  .email-wrapper { padding: 40px 20px; }
  .email-container {
    max-width: 560px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 16px;
    border: 1px solid #e5e7eb;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .email-header {
    background: #ffffff;
    padding: 24px 32px;
    border-bottom: 1px solid #e5e7eb;
  }
  .email-logo {
    font-size: 18px;
    font-weight: 700;
    color: #2a2929;
    text-decoration: none;
    letter-spacing: -0.3px;
  }
  .email-content { padding: 32px; }
  .email-h1 {
    font-size: 22px;
    font-weight: 700;
    color: #2a2929;
    margin: 0 0 16px;
  }
  .email-text {
    font-size: 15px;
    color: #555;
    margin: 0 0 16px;
  }
  .email-muted {
    font-size: 13px;
    color: #888;
    margin: 0 0 12px;
  }
  .email-btn {
    display: inline-block;
    padding: 12px 32px;
    background: #e8853d;
    color: #ffffff;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    border-radius: 9999px;
    margin: 8px 0 16px;
  }
  .email-btn-outline {
    display: inline-block;
    padding: 12px 32px;
    background: #ffffff;
    color: #2a2929;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    border-radius: 9999px;
    border: 1px solid #d4d4d4;
    margin: 8px 0 16px;
  }
  .email-btn-danger {
    display: inline-block;
    padding: 12px 32px;
    background: #ef4444;
    color: #ffffff;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
    border-radius: 9999px;
    margin: 8px 0 16px;
  }
  .email-divider {
    border: none;
    border-top: 1px solid #f1f5f9;
    margin: 24px 0;
  }
  .email-footer {
    padding: 20px 32px;
    background: #ffffff;
    border-top: 1px solid #e5e7eb;
    text-align: center;
  }
  .email-footer-text {
    font-size: 12px;
    color: #888;
    margin: 0;
  }
  .email-badge {
    display: inline-block;
    padding: 4px 10px;
    background: #fff7ed;
    color: #e8853d;
    font-size: 12px;
    font-weight: 600;
    border-radius: 9999px;
    border: 1px solid rgba(232,133,61,0.15);
  }
  .email-detail-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #f4f4f5;
  }
  .email-detail-label {
    font-size: 13px;
    color: #888;
  }
  .email-detail-value {
    font-size: 13px;
    font-weight: 600;
    color: #2a2929;
  }`

const DARK_STYLES = `
  @media (prefers-color-scheme: dark) {
    .email-body { background-color: #1a1a1e; color: #e4e4e7; }
    .email-container { background: #27272a; border-color: #3f3f46; box-shadow: 0 1px 4px rgba(0,0,0,0.3); }
    .email-header { background: #27272a; border-bottom-color: #3f3f46; }
    .email-logo { color: #fafafa; }
    .email-h1 { color: #fafafa; }
    .email-text { color: #d4d4d8; }
    .email-muted { color: #a1a1aa; }
    .email-btn-outline { background: #3f3f46; color: #fafafa; border-color: #52525b; }
    .email-divider { border-top-color: #3f3f46; }
    .email-footer { background: #27272a; border-top-color: #3f3f46; }
    .email-footer-text { color: #71717a; }
    .email-badge { background: rgba(232,133,61,0.15); color: #f0a970; border-color: rgba(232,133,61,0.25); }
    .email-detail-row { border-bottom-color: #3f3f46; }
    .email-detail-label { color: #a1a1aa; }
    .email-detail-value { color: #fafafa; }
  }`

const STYLES = `\n<style>${LIGHT_STYLES}\n${DARK_STYLES}\n</style>`

/** Dark overrides without media query — used by the preview tool to force dark mode. */
export const DARK_STYLE_OVERRIDES = DARK_STYLES.replace(
  '@media (prefers-color-scheme: dark) {',
  '',
).replace(/\}\s*$/, '')

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
        <a href="${EMAIL_CONSTANTS.APP_URL}" style="display:inline-block;text-decoration:none;">
          <img src="${EMAIL_CONSTANTS.LOGO_URL}" alt="${EMAIL_CONSTANTS.APP_NAME}" width="169" height="58" style="display:block;height:40px;width:auto;" />
        </a>
      </div>
      <div class="email-content">
        ${content}
      </div>
      <div class="email-footer">
        <p class="email-footer-text">&copy; {{currentYear}} Shogo. All rights reserved</p>
      </div>
    </div>
  </div>
</body>
</html>`
}
