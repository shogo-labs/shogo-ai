// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace event contract shared by the Shogo API, agent runtimes, and
 * third-party apps. Payload schemas are a small JSON-schema subset so the
 * package stays dependency-free.
 */

export type EventFieldSchema =
  | { type: 'string'; optional?: boolean; enum?: readonly string[]; scope?: string; description?: string }
  | { type: 'number' | 'boolean'; optional?: boolean; scope?: string; description?: string }
  | { type: 'object'; optional?: boolean; scope?: string; description?: string; properties: Record<string, EventFieldSchema> }
  | { type: 'array'; optional?: boolean; scope?: string; description?: string; items: EventFieldSchema }
  | { type: 'any'; optional?: boolean; scope?: string; description?: string }

export interface EventDefinition<P = unknown> {
  /** Dotted event name, e.g. `member.joined`. */
  type: string
  /** Bumped on breaking payload changes; additive changes keep the version. */
  version: number
  description: string
  /** Scope required to receive the event at all. */
  scope: string
  payload: Extract<EventFieldSchema, { type: 'object' }>
  example: P
}

/** What every subscriber (agent, project hook, webhook) receives. */
export interface WorkspaceEventEnvelope<P = unknown> {
  id: string
  type: string
  version: number
  workspaceId: string
  occurredAt: string
  payload: P
}

export interface MemberJoinedPayload {
  member: {
    userId: string
    name?: string
    role: string
    /** Requires `members:read.email`. */
    email?: string
  }
  source: 'invitation' | 'invite_link'
}
