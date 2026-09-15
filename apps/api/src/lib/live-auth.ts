// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { prisma } from './prisma'
import { verifyProxyToken, type ProxyTokenPayload } from './ai-proxy-token'
import { verifyRuntimeToken } from './runtime-token'
import { resolveApiKey } from '../routes/api-keys'

/**
 * Extract a Shogo bearer from HTTP or a browser WebSocket subprotocol.
 *
 * Browsers cannot set an Authorization header in the WebSocket constructor,
 * so the SDK uses `shogo-insecure-api-key.<token>` as a short-lived transport
 * credential. The token itself is still validated exactly like a bearer.
 */
export function extractLiveToken(headers: Headers): string | null {
  const authorization = headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7)

  const protocols = headers.get('sec-websocket-protocol')?.split(',').map((x) => x.trim()) ?? []
  const protocol = protocols.find((value) => value.startsWith('shogo-insecure-api-key.'))
  return protocol ? protocol.slice('shogo-insecure-api-key.'.length) : null
}

async function resolveRuntimeTokenPayload(token: string): Promise<ProxyTokenPayload | null> {
  const verified = verifyRuntimeToken(token)
  if (!verified.ok) return null

  const project = await prisma.project.findUnique({
    where: { id: verified.projectId },
    select: {
      workspaceId: true,
      members: {
        where: { role: 'owner' },
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
        take: 1,
      },
      workspace: {
        select: {
          members: {
            where: { role: 'owner' },
            orderBy: { createdAt: 'asc' },
            select: { userId: true },
            take: 1,
          },
        },
      },
    },
  })
  const userId = project?.members[0]?.userId ?? project?.workspace.members[0]?.userId
  if (!project || !userId) return null

  const now = Math.floor(Date.now() / 1000)
  return {
    projectId: verified.projectId,
    workspaceId: project.workspaceId,
    userId,
    type: 'ai-proxy',
    authKind: 'runtime',
    iat: now,
    exp: now + 3600,
  }
}

/** Authenticate a Live HTTP or WebSocket request using the existing proxy credentials. */
export async function authenticateLiveHeaders(headers: Headers): Promise<ProxyTokenPayload | null> {
  const token = extractLiveToken(headers)
  if (!token) return null

  if (token.startsWith('shogo_sk_')) {
    const resolved = await resolveApiKey(token)
    if (!resolved) return null
    const now = Math.floor(Date.now() / 1000)
    return {
      projectId: 'api-key',
      workspaceId: resolved.workspaceId,
      userId: resolved.userId,
      type: 'ai-proxy',
      authKind: 'api-key',
      iat: now,
      exp: now + 3600,
    }
  }

  if (token.startsWith('rt_v1_')) return resolveRuntimeTokenPayload(token)

  const jwt = await verifyProxyToken(token)
  return jwt ? { ...jwt, authKind: 'proxy-jwt' } : null
}
