// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo.app.json`: what a marketplace app subscribes to and the access it
 * asks the installer for.
 *
 *   {
 *     "schemaVersion": 1,
 *     "scopes": ["members:read"],
 *     "optionalScopes": ["members:read.email"],
 *     "requiredToolkits": ["github"],
 *     "events": [
 *       { "type": "member.joined", "target": "hook" },
 *       { "type": "composio.github.GITHUB_ISSUE_ADDED_EVENT", "target": "agent",
 *         "prompt": "Triage the new issue", "config": { "owner": "acme", "repo": "app" } }
 *     ]
 *   }
 *
 * `hook` events run the app's own `hooks/<name>/HOOK.md` handlers; `agent`
 * events wake the app's agent with `prompt`.
 */

import { EVENT_SCOPES, NATIVE_EVENTS, composioScope, eventTypeMatches, getEventDefinition, parseComposioEventType } from './catalog'

export const APP_MANIFEST_FILE = 'shogo.app.json'
export const MAX_APP_EVENTS = 20

export interface AppEventSpec {
  type: string
  target: 'hook' | 'agent'
  name?: string
  prompt?: string
  filter?: Record<string, unknown>
  /** Composio trigger config (e.g. `{ owner, repo }`). */
  config?: Record<string, unknown>
}

export interface ShogoAppManifest {
  schemaVersion: 1
  scopes: string[]
  optionalScopes: string[]
  requiredToolkits: string[]
  events: AppEventSpec[]
}

export type ParseAppManifestResult =
  | { ok: true; manifest: ShogoAppManifest }
  | { ok: false; errors: string[] }

const TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Known scope, or `composio:<toolkit>:read`. */
export function isKnownScope(scope: string): boolean {
  if (scope in EVENT_SCOPES) return true
  const m = /^composio:([a-z0-9_-]+):read$/.exec(scope)
  return !!m && TOOLKIT_RE.test(m[1])
}

/** Scopes needed to receive events matching `pattern` (wildcards need every matching event's scope). */
export function scopesForEventPattern(pattern: string): string[] {
  const composio = parseComposioEventType(pattern)
  if (composio) return [composioScope(composio.toolkit)]
  const defs = pattern.endsWith('*') ? NATIVE_EVENTS.filter((d) => eventTypeMatches(pattern, d.type)) : [getEventDefinition(pattern)].filter(Boolean)
  return [...new Set(defs.map((d) => d!.scope).filter((s): s is string => !!s))]
}

function stringList(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    errors.push(`${field} must be a list of strings`)
    return []
  }
  return [...new Set(value.map((v) => v.trim()).filter(Boolean))]
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseAppManifest(raw: unknown): ParseAppManifestResult {
  let input = raw
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw)
    } catch (error) {
      return { ok: false, errors: [`${APP_MANIFEST_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
    }
  }
  if (!plainObject(input)) return { ok: false, errors: [`${APP_MANIFEST_FILE} must be a JSON object`] }

  const errors: string[] = []
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) errors.push('schemaVersion must be 1')

  const scopes = stringList(input.scopes, 'scopes', errors)
  const optionalScopes = stringList(input.optionalScopes, 'optionalScopes', errors).filter((s) => !scopes.includes(s))
  for (const scope of [...scopes, ...optionalScopes]) {
    if (!isKnownScope(scope)) errors.push(`Unknown scope "${scope}". Known scopes: ${Object.keys(EVENT_SCOPES).join(', ')}, composio:<toolkit>:read`)
  }

  const requiredToolkits = stringList(input.requiredToolkits, 'requiredToolkits', errors).map((t) => t.toLowerCase())
  for (const toolkit of requiredToolkits) {
    if (!TOOLKIT_RE.test(toolkit)) errors.push(`requiredToolkits: "${toolkit}" is not a toolkit slug`)
  }

  const events: AppEventSpec[] = []
  if (input.events !== undefined && !Array.isArray(input.events)) errors.push('events must be a list')
  const rawEvents = Array.isArray(input.events) ? input.events : []
  if (rawEvents.length > MAX_APP_EVENTS) errors.push(`events may list at most ${MAX_APP_EVENTS} subscriptions`)
  rawEvents.slice(0, MAX_APP_EVENTS).forEach((spec, i) => {
    const at = `events[${i}]`
    if (!plainObject(spec) || typeof spec.type !== 'string' || !spec.type.trim()) {
      errors.push(`${at}.type is required`)
      return
    }
    const type = spec.type.trim()
    const composio = parseComposioEventType(type)
    if (type.startsWith('composio.')) {
      if (!composio || type.includes('*')) {
        errors.push(`${at}: Composio events need an exact type like composio.github.GITHUB_ISSUE_ADDED_EVENT (got ${type})`)
        return
      }
      if (!requiredToolkits.includes(composio.toolkit)) {
        errors.push(`${at}: ${type} needs "${composio.toolkit}" in requiredToolkits`)
      }
    } else if (type.endsWith('*')) {
      if (!NATIVE_EVENTS.some((d) => eventTypeMatches(type, d.type))) errors.push(`${at}: no Shogo event matches ${type}`)
    } else if (!getEventDefinition(type)) {
      errors.push(`${at}: unknown event type ${type}`)
    }
    for (const needed of scopesForEventPattern(type)) {
      if (!scopes.includes(needed) && !(composio && needed === composioScope(composio.toolkit))) {
        errors.push(`${at}: ${type} requires the "${needed}" scope; add it to scopes`)
      }
    }

    const target = spec.target ?? 'hook'
    if (target !== 'hook' && target !== 'agent') {
      errors.push(`${at}.target must be "hook" or "agent"`)
      return
    }
    const prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : undefined
    if (target === 'agent' && !prompt) errors.push(`${at}.prompt is required for agent targets`)
    if (spec.filter !== undefined && !plainObject(spec.filter)) errors.push(`${at}.filter must be an object`)
    if (spec.config !== undefined && !plainObject(spec.config)) errors.push(`${at}.config must be an object`)
    if (spec.config !== undefined && !composio) errors.push(`${at}.config only applies to Composio events`)
    if (spec.name !== undefined && typeof spec.name !== 'string') errors.push(`${at}.name must be a string`)
    events.push({
      type,
      target,
      ...(typeof spec.name === 'string' && spec.name.trim() ? { name: spec.name.trim().slice(0, 120) } : {}),
      ...(prompt ? { prompt: prompt.slice(0, 10_000) } : {}),
      ...(plainObject(spec.filter) ? { filter: spec.filter } : {}),
      ...(plainObject(spec.config) ? { config: spec.config } : {}),
    })
  })
  const seen = new Set<string>()
  for (const e of events) {
    const key = `${e.type}|${e.target}|${e.name ?? ''}`
    if (seen.has(key)) errors.push(`events: ${e.type} (${e.target}) is listed twice; give one a distinct name`)
    seen.add(key)
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, manifest: { schemaVersion: 1, scopes, optionalScopes, requiredToolkits, events } }
}

/**
 * Scopes an install of `manifest` ends up holding: every required scope,
 * each requested optional scope, and the read scope of each required toolkit.
 */
export function grantableScopes(manifest: ShogoAppManifest, acceptedOptional: readonly string[] = []): string[] {
  return [...new Set([
    ...manifest.scopes,
    ...manifest.optionalScopes.filter((s) => acceptedOptional.includes(s)),
    ...manifest.requiredToolkits.map(composioScope),
  ])]
}
