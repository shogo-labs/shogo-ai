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

export const NATIVE_EVENTS: readonly EventDefinition<any>[] = [memberJoined]

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
