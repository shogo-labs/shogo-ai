// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Known integration tags surfaced as "Works with" chips on detail pages and
 * inside the listing editor. Each entry maps a lowercase tag to a display
 * label, the Lucide icon name to render, and an optional brand tint used by
 * the IntegrationStrip component.
 *
 * Keep this list small and curated. Tags that aren't in the map render as
 * plain text chips.
 */
export interface KnownIntegration {
  /** Display label shown in chips and editor suggestions. */
  label: string
  /** Lucide icon component name (matched at the call site). */
  icon: string
  /** Optional brand color (`#rrggbb`) for tinted backgrounds. */
  color?: string
}

export const KNOWN_INTEGRATIONS: Record<string, KnownIntegration> = {
  // Communication
  gmail: { label: 'Gmail', icon: 'Mail', color: '#ea4335' },
  email: { label: 'Email', icon: 'Mail' },
  slack: { label: 'Slack', icon: 'MessageSquare', color: '#4a154b' },
  discord: { label: 'Discord', icon: 'MessageCircle', color: '#5865f2' },
  telegram: { label: 'Telegram', icon: 'Send', color: '#26a5e4' },
  sms: { label: 'SMS', icon: 'MessageSquare' },

  // Productivity
  notion: { label: 'Notion', icon: 'FileText', color: '#000000' },
  'google-docs': { label: 'Google Docs', icon: 'FileText', color: '#4285f4' },
  'google-sheets': { label: 'Google Sheets', icon: 'Sheet', color: '#0f9d58' },
  'google-calendar': { label: 'Google Calendar', icon: 'Calendar', color: '#4285f4' },
  calendar: { label: 'Calendar', icon: 'Calendar' },
  airtable: { label: 'Airtable', icon: 'Sheet', color: '#fcb400' },
  asana: { label: 'Asana', icon: 'CheckSquare', color: '#f06a6a' },
  trello: { label: 'Trello', icon: 'Trello', color: '#0079bf' },
  jira: { label: 'Jira', icon: 'Bug', color: '#0052cc' },
  linear: { label: 'Linear', icon: 'GitBranch', color: '#5e6ad2' },

  // Developer
  github: { label: 'GitHub', icon: 'Github', color: '#181717' },
  gitlab: { label: 'GitLab', icon: 'GitBranch', color: '#fc6d26' },
  vercel: { label: 'Vercel', icon: 'Triangle', color: '#000000' },
  npm: { label: 'npm', icon: 'Package', color: '#cb3837' },

  // Storage / data
  'google-drive': { label: 'Google Drive', icon: 'FolderOpen', color: '#1fa463' },
  dropbox: { label: 'Dropbox', icon: 'FolderOpen', color: '#0061ff' },
  s3: { label: 'AWS S3', icon: 'Database', color: '#ff9900' },
  postgres: { label: 'Postgres', icon: 'Database', color: '#336791' },
  mysql: { label: 'MySQL', icon: 'Database', color: '#4479a1' },
  supabase: { label: 'Supabase', icon: 'Database', color: '#3ecf8e' },

  // Web / scraping
  web: { label: 'Web', icon: 'Globe' },
  http: { label: 'HTTP', icon: 'Globe' },
  scraping: { label: 'Web scraping', icon: 'Search' },
  search: { label: 'Search', icon: 'Search' },

  // Models
  claude: { label: 'Claude', icon: 'Sparkles', color: '#cc785c' },
  openai: { label: 'OpenAI', icon: 'Sparkles', color: '#10a37f' },
  gemini: { label: 'Gemini', icon: 'Sparkles', color: '#4285f4' },

  // Commerce
  stripe: { label: 'Stripe', icon: 'CreditCard', color: '#635bff' },
  shopify: { label: 'Shopify', icon: 'ShoppingBag', color: '#7ab55c' },

  // Marketing / sales
  hubspot: { label: 'HubSpot', icon: 'Users', color: '#ff7a59' },
  salesforce: { label: 'Salesforce', icon: 'Users', color: '#00a1e0' },
  mailchimp: { label: 'Mailchimp', icon: 'Mail', color: '#ffe01b' },
}

/**
 * Permissions copy. Tags drive the "This agent uses" trust block on the
 * detail page. Each tag maps to a single sentence written in the
 * positive/active voice (Notion-style: "Reads from your inbox" rather than
 * "Required permission: read inbox").
 */
export const TAG_PERMISSION_COPY: Record<string, string> = {
  gmail: 'Reads from and sends through your Gmail inbox',
  email: 'Sends emails on your behalf',
  slack: 'Posts and reads messages in your Slack workspace',
  discord: 'Sends messages in your Discord servers',
  telegram: 'Sends messages through Telegram',
  sms: 'Sends SMS messages',
  notion: 'Reads and writes pages in your Notion workspace',
  'google-docs': 'Reads and edits your Google Docs',
  'google-sheets': 'Reads and updates your Google Sheets',
  'google-calendar': 'Reads and creates calendar events',
  calendar: 'Reads and creates calendar events',
  airtable: 'Reads and updates Airtable bases',
  asana: 'Creates and updates Asana tasks',
  trello: 'Manages cards on your Trello boards',
  jira: 'Creates and updates Jira issues',
  linear: 'Creates and updates Linear issues',
  github: 'Reads repositories and opens pull requests',
  gitlab: 'Reads repositories and opens merge requests',
  vercel: 'Reads deployment status from Vercel',
  npm: 'Looks up packages on npm',
  'google-drive': 'Reads and writes files in your Google Drive',
  dropbox: 'Reads and writes files in your Dropbox',
  s3: 'Reads and writes objects in S3 buckets you connect',
  postgres: 'Queries Postgres databases you connect',
  mysql: 'Queries MySQL databases you connect',
  supabase: 'Reads and writes to your Supabase project',
  web: 'Browses the public web',
  http: 'Makes HTTP requests to APIs you allow',
  scraping: 'Extracts content from web pages',
  search: 'Searches the web for relevant information',
  stripe: 'Reads payment data and creates customers in Stripe',
  shopify: 'Manages products and orders in your Shopify store',
  hubspot: 'Reads and updates contacts and deals in HubSpot',
  salesforce: 'Reads and updates records in Salesforce',
  mailchimp: 'Manages audiences and campaigns in Mailchimp',
}

/**
 * Resolve a tag to its known-integration metadata, or null when the tag
 * isn't in the curated list (caller falls back to a plain text chip).
 */
export function resolveIntegration(tag: string): KnownIntegration | null {
  const key = tag.trim().toLowerCase()
  return KNOWN_INTEGRATIONS[key] ?? null
}

/**
 * Resolve a tag to a Notion-style positive permission sentence, or null
 * when no copy is registered for that tag.
 */
export function resolvePermissionCopy(tag: string): string | null {
  const key = tag.trim().toLowerCase()
  return TAG_PERMISSION_COPY[key] ?? null
}
