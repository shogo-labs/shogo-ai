// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Templates Registry
 *
 * All templates live in packages/agent-runtime/templates/<id>/ and are loaded
 * by the directory-based template-loader.
 */

import type { TemplateIntegrationRef } from './integration-catalog'
import { loadDirTemplates } from './template-loader'

export interface AgentTemplate {
  id: string
  name: string
  description: string
  category: TemplateCategory
  icon: string
  tags: string[]

  /** Runtime settings written to config.json and AgentConfig DB row */
  settings: {
    heartbeatInterval: number
    heartbeatEnabled: boolean
    modelProvider: string
    modelName: string
    quietHours?: { start: string; end: string; timezone: string }
    mcpServers?: Record<string, { command: string; args: string[] }>
    webEnabled?: boolean
    browserEnabled?: boolean
    shellEnabled?: boolean
    imageGenEnabled?: boolean
    memoryEnabled?: boolean
    quickActionsEnabled?: boolean
    [key: string]: unknown
  }

  /** Bundled skill file names to auto-install into workspace skills/ dir */
  skills: string[]

  /** Workspace files seeded on first boot */
  files: Record<string, string>

  /** Composio integration categories the template recommends connecting */
  integrations?: TemplateIntegrationRef[]

  /** Default tech stack to seed when creating a project with this template */
  techStack?: string
}

export type TemplateCategory =
  | 'personal'
  | 'development'
  | 'business'
  | 'research'
  | 'operations'
  | 'marketing'
  | 'sales'

export const TEMPLATE_CATEGORIES: Record<TemplateCategory, { label: string; icon: string; description: string }> = {
  personal: { label: 'Personal Productivity', icon: '🧑', description: 'Assistants for daily life and personal tasks' },
  development: { label: 'Development', icon: '💻', description: 'Tools for software development workflows' },
  business: { label: 'Business & Marketing', icon: '📈', description: 'Agents for business operations and growth' },
  research: { label: 'Research & Analysis', icon: '🔬', description: 'Research, monitoring, and data analysis' },
  operations: { label: 'DevOps & Infrastructure', icon: '🔧', description: 'Infrastructure monitoring and operations' },
  marketing: { label: 'Marketing & Content', icon: '📣', description: 'Social media, SEO, newsletters, and content' },
  sales: { label: 'Sales & CRM', icon: '🤝', description: 'Pipeline management, outreach, and deal tracking' },
}

export const AGENT_TEMPLATES: AgentTemplate[] = loadDirTemplates()

export function getAgentTemplateById(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id)
}

export function getTemplatesByCategory(category: TemplateCategory): AgentTemplate[] {
  return AGENT_TEMPLATES.filter((t) => t.category === category)
}

export function getTemplateSummaries(): Array<Omit<AgentTemplate, 'files'> & { techStack?: string }> {
  return AGENT_TEMPLATES.map(({ files: _files, ...rest }) => rest)
}
