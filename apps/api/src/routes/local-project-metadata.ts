// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import {
  fallbackGenerateProjectName,
  shouldPersistGeneratedProjectName,
  type TitleSource,
} from '../lib/title-parse'

interface GeneratedProjectName {
  name: string
  description: string
  source: TitleSource
}

async function generateProjectNameFromCloud(prompt: string): Promise<GeneratedProjectName | null> {
  const apiKey = process.env.SHOGO_API_KEY
  if (!apiKey) return null

  try {
    const response = await fetch(`${getShogoCloudUrl()}/api/generate-project-name`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) return null

    const result = await response.json().catch(() => null) as {
      name?: unknown
      description?: unknown
      source?: unknown
    } | null
    if (result?.source !== 'ai' || typeof result.name !== 'string' || !result.name.trim()) {
      return null
    }

    return {
      name: result.name.trim(),
      description: typeof result.description === 'string' ? result.description.trim() : '',
      source: 'ai',
    }
  } catch {
    return null
  }
}

export function localProjectMetadataRoutes(): Hono {
  const router = new Hono()

  router.post('/generate-project-name', async (c) => {
    const body = await c.req.json().catch(() => ({} as any))
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return c.json({ error: 'Prompt is required' }, 400)

    const generated = await generateProjectNameFromCloud(prompt) ?? {
      name: fallbackGenerateProjectName(prompt),
      description: prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt,
      source: 'heuristic' as const,
    }

    if (typeof body?.projectId === 'string') {
      const project = await prisma.project.findUnique({
        where: { id: body.projectId },
        select: { name: true },
      })
      if (project && generated.source === 'ai' && shouldPersistGeneratedProjectName(project.name)) {
        await prisma.project.update({
          where: { id: body.projectId },
          data: { name: generated.name, description: generated.description },
        }).catch(() => {})
      }
    }
    return c.json(generated)
  })

  // Cloud templates are not copied into a desktop install. Keep the
  // compatibility shape so an older renderer can render an empty picker and
  // fall back to tech-stack creation instead of receiving a 404.
  router.get('/templates', (c) => c.json({ templates: [] }))

  return router
}
