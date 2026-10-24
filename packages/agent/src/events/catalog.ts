// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { EventDefinition, EventFieldSchema, MemberJoinedPayload } from './types'

export function defineEvent<P>(def: EventDefinition<P>): EventDefinition<P> {
  return def
}

/** Scopes an app can request. Composio events use `composio:<toolkit>:read`. */
export const EVENT_SCOPES: Record<string, string> = {
  'members:read': 'See when people join the workspace (name, role)',
  'members:read.email': "See new members' email addresses",
  'chat:read': 'Read public team chat channels',
  'chat:write': 'Post messages and send direct messages as the app',
  'channels:read': 'List team chat channels',
  'channels:manage': 'Add people to team chat channels',
  'social:read':
    "See comments, DMs and connected-account status from the workspace's social accounts",
}

export const memberJoined = defineEvent<MemberJoinedPayload>({
  type: 'member.joined',
  version: 1,
  description: 'Someone joined the workspace, through an email invitation or an invite link.',
  scope: 'members:read',
  payload: {
    type: 'object',
    properties: {
      member: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          name: { type: 'string', optional: true },
          role: { type: 'string' },
          email: { type: 'string', optional: true, scope: 'members:read.email' },
        },
      },
      source: { type: 'string', enum: ['invitation', 'invite_link'] },
    },
  },
  example: {
    member: { userId: 'user_123', name: 'Ada Lovelace', role: 'member', email: 'ada@example.com' },
    source: 'invite_link',
  },
})

/**
 * Social events come from Zernio's webhooks, not from us: a comment, a DM or an
 * account changing health. `externalId` is the profile's routing id
 * (`ws_<workspaceId>` / `lws_<localWorkspaceId>`), which is how a subscriber
 * can tell the cloud scope from one of a desktop's local workspaces.
 *
 * Provider-specific detail (`comment`, `message`, `run`) is passed through as
 * `any` on purpose: Zernio owns those shapes and extends them, and a trigger
 * filter reads a dot path into them rather than a schema we would have to keep
 * chasing.
 */
const socialAccount = {
  type: 'object',
  properties: {
    zernioAccountId: { type: 'string' },
    platform: { type: 'string' },
    username: { type: 'string' },
  },
} as const

const socialBase = {
  externalId: { type: 'string', description: 'The profile routing id: ws_<workspaceId> or lws_<localWorkspaceId>.' },
  /** Absent when the provider's event does not name the account it came from. */
  account: { ...socialAccount, optional: true },
} as const

export const socialCommentReceived = defineEvent({
  type: 'social.comment.received',
  version: 1,
  description: 'Someone commented on a post published from one of the workspace\'s connected accounts.',
  scope: 'social:read',
  payload: {
    type: 'object',
    properties: { ...socialBase, comment: { type: 'any' } },
  },
  example: {
    externalId: 'ws_1f0d',
    account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
    comment: { id: 'cmt_1', text: 'MERGE', authorUsername: 'ada' },
  },
})

export const socialMessageReceived = defineEvent({
  type: 'social.message.received',
  version: 1,
  description: 'A direct message arrived on one of the workspace\'s connected accounts.',
  scope: 'social:read',
  payload: {
    type: 'object',
    properties: { ...socialBase, message: { type: 'any' } },
  },
  example: {
    externalId: 'ws_1f0d',
    account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
    message: { id: 'msg_1', text: 'Do you ship to the EU?', authorUsername: 'ada' },
  },
})

export const socialMessageSent = defineEvent({
  type: 'social.message.sent',
  version: 1,
  description: 'A direct message was sent from one of the workspace\'s connected accounts.',
  scope: 'social:read',
  payload: {
    type: 'object',
    properties: { ...socialBase, message: { type: 'any' } },
  },
  example: {
    externalId: 'ws_1f0d',
    account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
    message: { id: 'msg_2', text: 'Yes — here is the link', authorUsername: 'acme' },
  },
})

export const socialAccountConnected = defineEvent({
  type: 'social.account.connected',
  version: 1,
  description: 'An account was connected to this workspace\'s social profile.',
  scope: 'social:read',
  payload: {
    type: 'object',
    properties: { ...socialBase },
  },
  example: {
    externalId: 'ws_1f0d',
    account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
  },
})

export const socialAccountDisconnected = defineEvent({
  type: 'social.account.disconnected',
  version: 1,
  description: 'An account was disconnected or its token stopped working, so it needs reconnecting.',
  scope: 'social:read',
  payload: {
    type: 'object',
    properties: { ...socialBase },
  },
  example: {
    externalId: 'ws_1f0d',
    account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
  },
})

export const socialAutomationRunCompleted = defineEvent({
  type: 'social.automation.run.completed',
  version: 1,
  description: 'A comment→DM automation or sequence finished a run.',
  scope: 'social:read',
  payload: {
    type: 'object',
    properties: { ...socialBase, run: { type: 'any' } },
  },
  example: {
    externalId: 'ws_1f0d',
    account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
    run: { id: 'run_1', status: 'completed', triggeredBy: 'cmt_1' },
  },
})

export const socialAutomationRunFailed = defineEvent({
  type: 'social.automation.run.failed',
  version: 1,
  description: 'A comment→DM automation or sequence run failed.',
  scope: 'social:read',
  payload: {
    type: 'object',
    properties: { ...socialBase, run: { type: 'any' } },
  },
  example: {
    externalId: 'ws_1f0d',
    account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
    run: { id: 'run_2', status: 'failed', error: 'private reply not allowed' },
  },
})

export const SOCIAL_EVENT_TYPES = [
  'social.comment.received',
  'social.message.received',
  'social.message.sent',
  'social.account.connected',
  'social.account.disconnected',
  'social.automation.run.completed',
  'social.automation.run.failed',
] as const

const SOCIAL_EVENTS: readonly EventDefinition<any>[] = [
  socialCommentReceived,
  socialMessageReceived,
  socialMessageSent,
  socialAccountConnected,
  socialAccountDisconnected,
  socialAutomationRunCompleted,
  socialAutomationRunFailed,
]

export const NATIVE_EVENTS: readonly EventDefinition<any>[] = [memberJoined, ...SOCIAL_EVENTS]

export const COMPOSIO_EVENT_PREFIX = 'composio.'

/** `composio.github.GITHUB_ISSUE_ADDED_EVENT` */
export function composioEventType(toolkit: string, triggerSlug: string): string {
  return `${COMPOSIO_EVENT_PREFIX}${toolkit.toLowerCase()}.${triggerSlug.toUpperCase()}`
}

export function parseComposioEventType(type: string): { toolkit: string; triggerSlug: string } | null {
  if (!type.startsWith(COMPOSIO_EVENT_PREFIX)) return null
  const rest = type.slice(COMPOSIO_EVENT_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0 || dot === rest.length - 1) return null
  return { toolkit: rest.slice(0, dot), triggerSlug: rest.slice(dot + 1) }
}

export function composioScope(toolkit: string): string {
  return `composio:${toolkit.toLowerCase()}:read`
}

export function getEventDefinition(type: string, version?: number): EventDefinition<any> | null {
  return NATIVE_EVENTS.find((e) => e.type === type && (version === undefined || e.version === version)) ?? null
}

/** Scope needed to receive `type`; Composio events map to their toolkit scope. */
export function scopeForEventType(type: string): string | null {
  const composio = parseComposioEventType(type)
  if (composio) return composioScope(composio.toolkit)
  return getEventDefinition(type)?.scope ?? null
}

/** True when `pattern` (exact type, or a `prefix.*` wildcard) matches `type`. */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === type || pattern === '*') return true
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1))
  return false
}

function validateField(schema: EventFieldSchema, value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) {
    if (!schema.optional) errors.push(`${path} is required`)
    return
  }
  switch (schema.type) {
    case 'any':
      return
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string`)
      else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`)
      return
    case 'number':
    case 'boolean':
      if (typeof value !== schema.type) errors.push(`${path} must be a ${schema.type}`)
      return
    case 'array':
      if (!Array.isArray(value)) errors.push(`${path} must be an array`)
      else value.forEach((item, i) => validateField(schema.items, item, `${path}[${i}]`, errors))
      return
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path} must be an object`)
        return
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        validateField(child, (value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, errors)
      }
  }
}

export function validateEventPayload(def: EventDefinition<any>, payload: unknown): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  validateField(def.payload, payload, '', errors)
  return errors.length ? { ok: false, errors } : { ok: true }
}

function redactField(schema: EventFieldSchema, value: unknown, granted: (scope: string) => boolean): unknown {
  if (value === undefined || value === null) return value
  if (schema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const child = schema.properties[key]
      if (!child) {
        out[key] = v
        continue
      }
      if (child.scope && !granted(child.scope)) continue
      out[key] = redactField(child, v, granted)
    }
    return out
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    return value.map((item) => redactField(schema.items, item, granted))
  }
  return value
}

/**
 * Drop payload fields whose scope isn't granted. `'*'` grants everything
 * (user-owned subscriptions see what their owner can see). Composio and
 * other uncatalogued payloads pass through unchanged.
 */
export function redactEventPayload<P>(type: string, payload: P, grantedScopes: readonly string[] | '*'): P {
  if (grantedScopes === '*') return payload
  const def = getEventDefinition(type)
  if (!def) return payload
  const set = new Set(grantedScopes)
  return redactField(def.payload, payload, (scope) => set.has(scope)) as P
}
