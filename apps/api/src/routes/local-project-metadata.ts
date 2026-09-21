// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { fallbackGenerateProjectName } from '../lib/title-parse'

export function localProjectMetadataRoutes(): Hono {
  const router = new Hono()

  router.post('/generate-project-name', async (c) => {
    const body = await c.req.json().catch(() => ({} as any))
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return c.json({ error: 'Prompt is required' }, 400)

    const name = fallbackGenerateProjectName(prompt)
    const description = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt
    if (typeof body?.projectId === 'string') {
      const project = await prisma.project.findUnique({
        where: { id: body.projectId },
        select: { name: true },
      })
      if (project && (!project.name || project.name === 'Untitled')) {
        await prisma.project.update({
          where: { id: body.projectId },
          data: { name, description },
        }).catch(() => {})
      }
    }
    return c.json({ name, description, source: 'heuristic' })
  })

  // Cloud templates are not copied into a desktop install. Keep the
  // compatibility shape so an older renderer can render an empty picker and
  // fall back to tech-stack creation instead of receiving a 404.
  router.get('/templates', (c) => c.json({ templates: [] }))

  return router
}
