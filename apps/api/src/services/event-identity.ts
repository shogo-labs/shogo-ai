// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who an event-triggered agent turn acts as.
 *
 * Every event may carry an actor: who did the thing on the other platform.
 * A subscription's `actsAs` picks the person whose accounts the project's
 * credential chain sees as "the person who asked":
 *
 *   subscriber  the subscription's owner (default)
 *   actor       the event's actor, when they map to exactly one workspace
 *               member through an identity link (or a verified email, if
 *               the subscription opts in)
 *   nobody      no person; the chain falls through to the shared account
 *
 * An actor that can't be matched gives no person rather than the
 * subscriber, so a stranger's event never borrows someone's account.
 */

import { signRequesterTicket, type EventPersonMatch } from '../lib/requester-ticket'
import { prisma } from '../lib/prisma'
import { findLinkedMember, findMemberByEmail } from './identity-links'

const db = prisma as any

export const ACTS_AS = ['subscriber', 'actor', 'nobody'] as const
export type ActsAs = (typeof ACTS_AS)[number]

/**
 * `platform`: the ids came from a verified delivery (a signed webhook, or
 * Shogo itself). `claimed`: someone's own code said so; never mapped.
 */
export interface EventActor {
  source: string
  externalId?: string
  email?: string
  trust: 'platform' | 'claimed'
}

export function isActsAs(value: unknown): value is ActsAs {
  return typeof value === 'string' && (ACTS_AS as readonly string[]).includes(value)
}

const PATH_RE = /^[A-Za-z_$][\w$-]*(\[\d+\])?(\.[A-Za-z_$][\w$-]*(\[\d+\])?)*$/

export function isValidActorPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 200 && PATH_RE.test(path)
}

/** `a.b[0].c` into `payload`. */
export function readPath(payload: unknown, path: string): unknown {
  let node: any = payload
  for (const part of path.split('.')) {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(part)
    if (!m || node == null || typeof node !== 'object') return undefined
    node = node[m[1]!]
    if (m[2] !== undefined) node = Array.isArray(node) ? node[Number(m[2])] : undefined
  }
  return node
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** The actor described by `payload` at the subscription's paths, if any. */
export function actorFromPayload(
  payload: unknown,
  opts: { source: string; idPath?: string | null; emailPath?: string | null },
): EventActor | null {
  const externalId = opts.idPath ? scalar(readPath(payload, opts.idPath)) : undefined
  const rawEmail = opts.emailPath ? scalar(readPath(payload, opts.emailPath)) : undefined
  const email = rawEmail?.includes('@') ? rawEmail.toLowerCase() : undefined
  if (!externalId && !email) return null
  return { source: opts.source, ...(externalId ? { externalId } : {}), ...(email ? { email } : {}), trust: 'platform' }
}

const PERSON_KEYS = /^(sender|user|author|creator|reporter|actor|owner|requester|requestor|from|organizer|submitter|assignee|member|commenter|created_?by|updated_?by|modified_?by|last_?modified_?by)$/i
const ID_LEAF = /^(id|accountId|account_id|user_?id|gid|login|username)$/i
const DIRECT_ID = /^(user_?id|sender_?id|author_?id|creator_?id|actor_?id|reporter_?id|owner_?id|from_?id|created_?by_?id)$/i
const EMAIL_LEAF = /e-?mail(_?address)?$/i

/**
 * Likely actor fields in a trigger's payload schema, best first. Suggestions
 * for the picker only; nothing is mapped until someone chooses a path.
 */
export function suggestActorFields(schema: unknown): { idPaths: string[]; emailPaths: string[] } {
  const ids: Array<{ path: string; score: number }> = []
  const emails: Array<{ path: string; score: number }> = []
  const walk = (node: any, path: string[], inPerson: boolean, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 4) return
    const props = node.properties ?? node.items?.properties
    if (!props || typeof props !== 'object') return
    for (const [key, child] of Object.entries<any>(props)) {
      const childPath = [...path, key]
      const type = child?.type
      const isLeaf = type === 'string' || type === 'number' || type === 'integer' || (Array.isArray(type) && !type.includes('object'))
      if (isLeaf) {
        const joined = childPath.join('.')
        if (EMAIL_LEAF.test(key)) emails.push({ path: joined, score: (inPerson ? 0 : 10) + depth })
        else if (inPerson && ID_LEAF.test(key)) ids.push({ path: joined, score: depth + (/^(login|username)$/i.test(key) ? 5 : 0) })
        else if (DIRECT_ID.test(key)) ids.push({ path: joined, score: depth + 1 })
      } else if (!Array.isArray(child?.items) && child?.type !== 'array') {
        walk(child, childPath, PERSON_KEYS.test(key), depth + 1)
      }
    }
  }
  walk(schema, [], false, 0)
  const order = (list: Array<{ path: string; score: number }>) =>
    [...new Map(list.sort((a, b) => a.score - b.score).map((e) => [e.path, e.path])).values()].slice(0, 8)
  return { idPaths: order(ids), emailPaths: order(emails) }
}

export interface EventPerson {
  userId: string
  match: EventPersonMatch
}

async function isMember(workspaceId: string, userId: string): Promise<boolean> {
  const row = await db.member.findFirst({ where: { workspaceId, userId }, select: { id: true } })
  return !!row
}

/** The person an event turn acts as under the subscription, or null for nobody. */
export async function resolveEventPerson(input: {
  workspaceId: string
  actsAs?: string | null
  ownerUserId?: string | null
  trustActorEmail?: boolean | null
  actor?: EventActor | null
}): Promise<EventPerson | null> {
  const actsAs: ActsAs = isActsAs(input.actsAs) ? input.actsAs : 'subscriber'
  if (actsAs === 'nobody') return null
  if (actsAs === 'subscriber') {
    const owner = input.ownerUserId
    return owner && (await isMember(input.workspaceId, owner)) ? { userId: owner, match: 'subscriber' } : null
  }

  const actor = input.actor
  if (!actor || actor.trust !== 'platform') return null
  if (actor.externalId) {
    if (actor.source === 'shogo') {
      if (await isMember(input.workspaceId, actor.externalId)) return { userId: actor.externalId, match: 'platform_id' }
    } else {
      const userId = await findLinkedMember(input.workspaceId, actor.source, actor.externalId)
      if (userId) return { userId, match: 'platform_id' }
    }
  }
  if (input.trustActorEmail && actor.email) {
    const userId = await findMemberByEmail(input.workspaceId, actor.email)
    if (userId) return { userId, match: 'platform_email' }
  }
  return null
}

/** The requester ticket for an event turn in `projectId`, or nothing without a person. */
export function eventRequesterTicket(
  projectId: string,
  person: EventPerson | null,
  event: { id: string; subscriptionId?: string; source: string },
): string | undefined {
  if (!person) return undefined
  try {
    return signRequesterTicket({
      projectId,
      userId: person.userId,
      origin: {
        kind: 'event',
        eventId: event.id,
        ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
        source: event.source,
        match: person.match,
      },
    })
  } catch (err: any) {
    console.warn('[EventIdentity] Could not sign a requester ticket:', err?.message ?? err)
    return undefined
  }
}
