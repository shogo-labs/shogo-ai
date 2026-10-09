// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Permission required for each route under `/api/projects/:projectId/*`,
 * enforced by `requireProjectAccess`.
 *
 * Every mutating project route must be listed here, either with a specific
 * permission or in `PROJECT_UPDATE_ROUTES` (plain `project:update`). The
 * route-coverage test fails when a new mutating route is not declared.
 * Paths are relative to `/api/projects/:projectId`; `:param` matches one
 * segment and a trailing `*` matches the rest.
 */

import type { ProjectPermission } from '@shogo/authz'

type Method = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ProjectRouteRule {
  methods: readonly Method[] | 'any' | 'write'
  paths: readonly string[]
  permission: ProjectPermission
}

const WRITE: readonly Method[] = ['POST', 'PUT', 'PATCH', 'DELETE']
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export const PROJECT_ROUTE_RULES: readonly ProjectRouteRule[] = [
  // Using the previewed app (including its own POSTs) is a read of the project.
  { methods: 'any', paths: ['/preview', '/preview/*'], permission: 'project:read' },
  // Git fetch/clone and LFS downloads are reads; the handlers escalate pushes
  // and LFS uploads to `project:update`.
  { methods: ['POST'], paths: ['/git/git-upload-pack', '/git/info/lfs/objects/batch'], permission: 'project:read' },
  { methods: ['POST'], paths: ['/export'], permission: 'project:export' },
  {
    methods: 'write',
    paths: [
      '/publish', '/publish/*', '/unpublish', '/republish',
      '/domains', '/domains/:domainId', '/domains/:domainId/*',
    ],
    permission: 'project:publish',
  },
  { methods: 'write', paths: ['/members', '/members/*', '/visibility'], permission: 'project.members:manage' },
  {
    methods: 'write',
    paths: [
      '/auth-config', '/auth-users/:userId', '/preferred-instance',
      '/github', '/github/authorize', '/github/connect',
    ],
    permission: 'project.settings:manage',
  },
]

/** Mutating routes that intentionally require plain `project:update`. */
export const PROJECT_UPDATE_ROUTES: readonly string[] = [
  '/chat', '/chat/*', '/permission-response',
  '/checkpoints', '/checkpoints/:checkpointId/rollback',
  '/database/start', '/database/stop', '/database/proxy', '/database/proxy/*',
  '/files/*', '/s3/presign',
  '/git/git-receive-pack', '/git/info/lfs/objects/verify',
  '/github/branch', '/github/pull', '/github/push', '/github/sync',
  // Credential policy routes also check `project.credentials:manage` (or
  // project creator) in the integration-credentials service.
  '/integrations/:provider/connect', '/integrations/policies/:provider', '/integrations/policies/:provider/delegate',
  '/runtime/prewarm', '/runtime/restart', '/runtime/start', '/runtime/stop',
  '/security/scan', '/tests/run', '/tests/traces',
  '/thumbnail', '/thumbnail/capture',
  '/agents/sync', '/agent/tool-mocks', '/agent-proxy', '/agent-proxy/*',
  '/apply-template', '/diagnostics/refresh', '/diagnostics/terminal',
  '/heartbeat', '/heartbeat/sync', '/ports', '/ports/:port',
  '/terminal/sessions', '/terminal/sessions/:id',
]

function templateToRegex(template: string): RegExp {
  const body = template
    .split('/')
    .map((seg) => (seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${body}/?$`)
}

const COMPILED = PROJECT_ROUTE_RULES.map((rule) => ({
  rule,
  regexes: rule.paths.map(templateToRegex),
}))

function methodMatches(rule: ProjectRouteRule, method: string): boolean {
  if (rule.methods === 'any') return true
  if (rule.methods === 'write') return WRITE.includes(method as Method)
  return rule.methods.includes(method as Method)
}

/**
 * Permission for `method subpath`, where `subpath` is the request path after
 * `/api/projects/:projectId` (e.g. `/publish`).
 */
export function projectRoutePermission(method: string, subpath: string): ProjectPermission {
  const m = method.toUpperCase()
  for (const { rule, regexes } of COMPILED) {
    if (methodMatches(rule, m) && regexes.some((r) => r.test(subpath))) return rule.permission
  }
  return SAFE_METHODS.has(m) ? 'project:read' : 'project:update'
}

const UPDATE_ROUTE_REGEXES = PROJECT_UPDATE_ROUTES.map(templateToRegex)

/**
 * True when a mutating route template is declared above, either listed
 * directly or covered by a wildcard entry (e.g. `/chat/stop` by `/chat/*`).
 */
export function isDeclaredProjectRoute(method: string, template: string): boolean {
  const m = method.toUpperCase()
  if (UPDATE_ROUTE_REGEXES.some((r) => r.test(template))) return true
  return COMPILED.some(
    ({ rule, regexes }) =>
      (m === 'ALL' ? rule.methods === 'any' : methodMatches(rule, m)) && regexes.some((r) => r.test(template)),
  )
}
