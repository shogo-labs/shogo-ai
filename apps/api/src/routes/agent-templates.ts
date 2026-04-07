// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Hono } from 'hono'
import { getTemplateSummaries, getAgentTemplateById, TEMPLATE_CATEGORIES } from '../../../../packages/agent-runtime/src/agent-templates'
import { listTechStacks, loadTechStackMeta } from '../../../../packages/agent-runtime/src/workspace-defaults'

export function agentTemplateRoutes() {
  const app = new Hono()

  app.get('/agent-templates', (c) => {
    return c.json({
      templates: getTemplateSummaries(),
      categories: TEMPLATE_CATEGORIES,
    })
  })

  app.get('/agent-templates/:id', (c) => {
    const template = getAgentTemplateById(c.req.param('id'))
    if (!template) {
      return c.json({ error: 'Template not found' }, 404)
    }
    return c.json({ template })
  })

  app.get('/tech-stacks', (c) => {
    return c.json({ stacks: listTechStacks() })
  })

  app.get('/tech-stacks/:id', (c) => {
    const stack = loadTechStackMeta(c.req.param('id'))
    if (!stack) {
      return c.json({ error: 'Tech stack not found' }, 404)
    }
    return c.json({ stack })
  })

  return app
}
