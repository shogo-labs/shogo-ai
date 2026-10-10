// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Permission an internal agent route enforces for the person behind the turn.
 * The route-coverage test fails when a new project-facing internal route is
 * not listed here. Paths are the Hono templates in `internal-runtime-routes.ts`.
 */

export const INTERNAL_AGENT_ROUTES: Readonly<Record<string, string>> = {
  'GET /workspaces/:workspaceId/projects': 'project:read',
  'POST /workspaces/:workspaceId/sessions/:sessionId/members': 'project:read',
  'DELETE /workspaces/:workspaceId/sessions/:sessionId/members/:projectId': 'project:read',
  'GET /workspaces/:workspaceId/history/search': 'project:read',
  'GET /workspaces/:workspaceId/history/read': 'project:read',
  'GET /chat-sessions/:chatSessionId/transcript': 'project:read',
  'GET /workspaces/:workspaceId/projects/graph': 'project:read',
  'POST /workspaces/:workspaceId/projects': 'project:create',
  'GET /projects/:projectId/attachments': 'project:read',
  'POST /projects/:projectId/attachments': 'project:update',
  'DELETE /projects/:projectId/attachments/:attachedProjectId': 'project:update',
  'GET /projects/:projectId/config': 'project:read',
  'PATCH /projects/:projectId/config': 'project:update|project.settings:manage',
  'POST /projects/:projectId/agent-call': 'project:update',
}

const AGENT_SURFACES: readonly RegExp[] = [
  /^\/workspaces\/:workspaceId\/projects$/,
  /^\/workspaces\/:workspaceId\/projects\/graph$/,
  /^\/workspaces\/:workspaceId\/sessions\/:sessionId\/members(?:\/:projectId)?$/,
  /^\/workspaces\/:workspaceId\/history\/(?:search|read)$/,
  /^\/chat-sessions\/:chatSessionId\/transcript$/,
  /^\/projects\/:projectId\/attachments(?:\/:attachedProjectId)?$/,
  /^\/projects\/:projectId\/config$/,
  /^\/projects\/:projectId\/agent-call$/,
]

/** True for internal routes an agent uses to list or change projects. */
export function isInternalAgentRoute(template: string): boolean {
  return AGENT_SURFACES.some((re) => re.test(template))
}
