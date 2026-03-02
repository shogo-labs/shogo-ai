import { Hono } from 'hono'
import { getTemplateSummaries, getAgentTemplateById, TEMPLATE_CATEGORIES } from '../../../../packages/agent-runtime/src/agent-templates'

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

  return app
}
