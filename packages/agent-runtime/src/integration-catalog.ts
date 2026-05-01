// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration Catalog
 *
 * Shared registry of integration categories and their Composio toolkit options.
 * Templates reference categories by ID so adding a new service (e.g. Monday.com)
 * only requires updating this catalog — every template that uses that category
 * picks it up automatically.
 */

export interface IntegrationOption {
  toolkit: string
  name: string
}

export interface IntegrationCategory {
  id: string
  label: string
  icon: string
  options: IntegrationOption[]
}

export interface TemplateIntegrationRef {
  categoryId: string
  description: string
  required?: boolean
}

export const INTEGRATION_CATALOG: Record<string, IntegrationCategory> = {
  'project-management': {
    id: 'project-management',
    label: 'Project Management',
    icon: 'kanban',
    options: [
      { toolkit: 'linear', name: 'Linear' },
      { toolkit: 'jira', name: 'Jira' },
      { toolkit: 'asana', name: 'Asana' },
      { toolkit: 'clickup', name: 'ClickUp' },
    ],
  },
  'communication': {
    id: 'communication',
    label: 'Communication',
    icon: 'message-square',
    options: [
      { toolkit: 'slack', name: 'Slack' },
      { toolkit: 'discord', name: 'Discord' },
    ],
  },
  'code-repository': {
    id: 'code-repository',
    label: 'Code Repository',
    icon: 'git-branch',
    options: [
      { toolkit: 'github', name: 'GitHub' },
      { toolkit: 'gitlab', name: 'GitLab' },
    ],
  },
  'email': {
    id: 'email',
    label: 'Email',
    icon: 'mail',
    options: [
      { toolkit: 'gmail', name: 'Gmail' },
    ],
  },
  'calendar': {
    id: 'calendar',
    label: 'Calendar',
    icon: 'calendar',
    options: [
      { toolkit: 'googlecalendar', name: 'Google Calendar' },
    ],
  },
  'crm': {
    id: 'crm',
    label: 'CRM',
    icon: 'users',
    options: [
      { toolkit: 'hubspot', name: 'HubSpot' },
      { toolkit: 'salesforce', name: 'Salesforce' },
    ],
  },
  'payments': {
    id: 'payments',
    label: 'Payments',
    icon: 'credit-card',
    options: [
      { toolkit: 'stripe', name: 'Stripe' },
    ],
  },
  'ticketing': {
    id: 'ticketing',
    label: 'Support Ticketing',
    icon: 'ticket',
    options: [
      { toolkit: 'zendesk', name: 'Zendesk' },
      { toolkit: 'freshdesk', name: 'Freshdesk' },
    ],
  },
  'monitoring': {
    id: 'monitoring',
    label: 'Error Monitoring',
    icon: 'alert-triangle',
    options: [
      { toolkit: 'sentry', name: 'Sentry' },
    ],
  },
  'notes': {
    id: 'notes',
    label: 'Notes & Knowledge Base',
    icon: 'notebook-pen',
    options: [
      { toolkit: 'notion', name: 'Notion' },
    ],
  },
  'travel': {
    id: 'travel',
    label: 'Travel',
    icon: 'plane',
    options: [
      { toolkit: 'airbnb', name: 'Airbnb' },
    ],
  },
  'voice': {
    id: 'voice',
    label: 'Voice & Telephony',
    icon: 'phone',
    options: [
      { toolkit: 'twilio', name: 'Twilio' },
      { toolkit: 'elevenlabs', name: 'ElevenLabs' },
    ],
  },
}

/**
 * Resolve a list of template integration refs into full category objects
 * with the template-specific description and required flag attached.
 */
export function resolveIntegrations(
  refs: TemplateIntegrationRef[],
): Array<IntegrationCategory & { description: string; required?: boolean }> {
  return refs
    .map((ref) => {
      const category = INTEGRATION_CATALOG[ref.categoryId]
      if (!category) return null
      return { ...category, description: ref.description, required: ref.required }
    })
    .filter(Boolean) as Array<IntegrationCategory & { description: string; required?: boolean }>
}
