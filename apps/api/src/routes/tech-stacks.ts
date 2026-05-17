// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tech-stack discovery routes — extracted from the deleted
 * `agent-templates` route module during the templates → marketplace
 * consolidation. Stacks describe the language/runtime each project
 * boots into (Vite/React, Expo, Python, Unity, …) and are independent
 * from any first-party template; they continue to exist as a separate
 * resource the mobile project-creation flow queries.
 */
import { Hono } from 'hono'
import { listTechStacks, loadTechStackMeta } from '../../../../packages/agent-runtime/src/workspace-defaults'

export function techStackRoutes() {
  const app = new Hono()

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
