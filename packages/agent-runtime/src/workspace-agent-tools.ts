// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Universal workspace-agent tools: read/update the agent identity profile
 * and manage goals. Despite the history (these started as "personal
 * workspace" tools), they are pushed for EVERY workspace runtime in
 * `gateway-tools.ts createTools()` — a team workspace's agent can track
 * goals too. Personal workspaces are simply the first product surface that
 * renders them (see `apps/mobile/components/personal/PersonalGoalsScreen.tsx`).
 */

import { existsSync, readFileSync } from 'fs'
import { extname } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './gateway-tools'
import { textResult } from './gateway-tools'
import { assertWithinWorkspace } from './permission-engine'
import {
  createGoal as apiCreateGoal,
  getAgentProfile,
  listGoals as apiListGoals,
  logGoalEvent,
  setAgentProfile,
  updateGoal as apiUpdateGoal,
  uploadAgentAvatar,
} from './internal-api'

const AVATAR_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function workspaceIdOf(ctx: ToolContext): string | null {
  return ctx.workspaceId || process.env.WORKSPACE_ID || null
}

function noWorkspace() {
  return textResult({
    error: 'This runtime has no workspace context, so personal workspace tools are unavailable.',
    code: 'no_workspace',
  })
}

function apiError(result: { error?: string; code?: string; status?: number }, fallback: string) {
  return textResult({
    error: result.error ?? fallback,
    code: result.code,
    status: result.status,
  })
}

export function createAgentProfileGetTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_profile_get',
    label: 'Get Agent Profile',
    description: 'Read the companion identity profile: name, avatar, tagline, personality, and current status.',
    parameters: Type.Object({}),
    execute: async () => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const result = await getAgentProfile(workspaceId)
      return result.ok && result.data ? textResult({ ok: true, profile: result.data }) : apiError(result, 'Could not read the agent profile')
    },
  }
}

export function createAgentProfileSetTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_profile_set',
    label: 'Update Agent Profile',
    description:
      'Update the companion identity: name, tagline, personality, or status text. For a new avatar, ' +
      'generate the image first with generate_image and pass its workspace path as avatarImagePath — ' +
      'this uploads the image to durable storage and sets the resulting URL for you. Only use the raw ' +
      'avatarUrl field for an already-public URL (e.g. one the user gave you directly).',
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      avatarUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      avatarImagePath: Type.Optional(
        Type.String({
          description:
            'Workspace-relative path to a generated image, e.g. "images/avatar.png" from generate_image. ' +
            'Uploaded to durable storage and used as the avatar; takes precedence over avatarUrl.',
        }),
      ),
      tagline: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      personality: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      statusText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()

      const { avatarImagePath, ...rest } = params as { avatarImagePath?: string; [key: string]: unknown }

      if (avatarImagePath) {
        let resolvedPath: string
        try {
          resolvedPath = assertWithinWorkspace(ctx.workspaceDir, avatarImagePath)
        } catch {
          return textResult({ error: `Invalid avatarImagePath: ${avatarImagePath}`, code: 'invalid_path' })
        }
        if (!existsSync(resolvedPath)) {
          return textResult({
            error: `Image not found at ${avatarImagePath}. Generate it first with generate_image.`,
            code: 'not_found',
          })
        }

        const buffer = readFileSync(resolvedPath)
        const contentType = AVATAR_IMAGE_MIME_TYPES[extname(resolvedPath).toLowerCase()] || 'image/png'
        const uploadResult = await uploadAgentAvatar(workspaceId, buffer, contentType)
        if (!uploadResult.ok || !uploadResult.data) {
          return apiError(uploadResult, 'Could not upload the avatar image')
        }

        // The avatar is already set server-side by the upload. Only make a
        // second call if there are other profile fields to change too.
        const { avatarUrl: _ignoredAvatarUrl, ...otherChanges } = rest
        if (Object.keys(otherChanges).length === 0) {
          return textResult({ ok: true, profile: uploadResult.data })
        }
        const result = await setAgentProfile(workspaceId, otherChanges as any)
        return result.ok && result.data
          ? textResult({ ok: true, profile: result.data })
          : apiError(result, 'Could not update the agent profile')
      }

      const result = await setAgentProfile(workspaceId, rest as any)
      return result.ok && result.data ? textResult({ ok: true, profile: result.data }) : apiError(result, 'Could not update the agent profile')
    },
  }
}

export function createGoalCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'goal_create',
    label: 'Create Goal',
    description: 'Create a long-running user goal with ordered plan steps and optional deliverables.',
    parameters: Type.Object({
      title: Type.String(),
      why: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('done')])),
      plan: Type.Optional(Type.Any()),
      deliverables: Type.Optional(Type.Any()),
      nextCheckInAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const result = await apiCreateGoal(workspaceId, params as any)
      return result.ok && result.data ? textResult({ ok: true, goal: result.data }) : apiError(result, 'Could not create the goal')
    },
  }
}

export function createGoalUpdateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'goal_update',
    label: 'Update Goal',
    description: 'Update a goal status, plan, check-in time, or deliverables. Deliverables may contain URL, file, or project artifacts.',
    parameters: Type.Object({
      goalId: Type.String(),
      title: Type.Optional(Type.String()),
      why: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('done')])),
      plan: Type.Optional(Type.Any()),
      deliverables: Type.Optional(Type.Any()),
      nextCheckInAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      lastProgressAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const { goalId, ...changes } = params as { goalId: string; [key: string]: unknown }
      const result = await apiUpdateGoal(workspaceId, goalId, changes as any)
      return result.ok && result.data ? textResult({ ok: true, goal: result.data }) : apiError(result, 'Could not update the goal')
    },
  }
}

export function createGoalLogTool(ctx: ToolContext): AgentTool {
  return {
    name: 'goal_log',
    label: 'Log Goal Progress',
    description: 'Append a progress, blocker, approval, note, or deliverable event to a goal.',
    parameters: Type.Object({
      goalId: Type.String(),
      kind: Type.Union([
        Type.Literal('progress'),
        Type.Literal('blocker'),
        Type.Literal('approval'),
        Type.Literal('note'),
        Type.Literal('deliverable'),
      ]),
      message: Type.String(),
      metadata: Type.Optional(Type.Any()),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { goalId: string; kind: 'progress' | 'blocker' | 'approval' | 'note' | 'deliverable'; message: string; metadata?: unknown }
      const result = await logGoalEvent(workspaceId, input.goalId, input)
      return result.ok && result.data ? textResult({ ok: true, event: result.data }) : apiError(result, 'Could not log goal progress')
    },
  }
}

export function createGoalListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'goal_list',
    label: 'List Goals',
    description: 'List the user goals, optionally filtered by active, paused, or done status.',
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('done')])),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { status?: 'active' | 'paused' | 'done' }
      const result = await apiListGoals(workspaceId, input.status)
      return result.ok ? textResult({ ok: true, goals: result.data ?? [] }) : apiError(result, 'Could not list goals')
    },
  }
}

export function createSetStatusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'set_status',
    label: 'Set Agent Status',
    description: 'Set the short status sentence shown beneath the companion name in the personal shell.',
    parameters: Type.Object({
      statusText: Type.Union([Type.String(), Type.Null()]),
    }),
    execute: async (_id, params) => {
      const workspaceId = workspaceIdOf(ctx)
      if (!workspaceId) return noWorkspace()
      const input = params as { statusText: string | null }
      const result = await setAgentProfile(workspaceId, { statusText: input.statusText })
      return result.ok && result.data ? textResult({ ok: true, statusText: result.data.statusText }) : apiError(result, 'Could not set agent status')
    },
  }
}

export const WORKSPACE_AGENT_TOOL_NAMES = [
  'agent_profile_get',
  'agent_profile_set',
  'goal_create',
  'goal_update',
  'goal_log',
  'goal_list',
  'set_status',
] as const

export function createWorkspaceAgentTools(ctx: ToolContext): AgentTool[] {
  return [
    createAgentProfileGetTool(ctx),
    createAgentProfileSetTool(ctx),
    createGoalCreateTool(ctx),
    createGoalUpdateTool(ctx),
    createGoalLogTool(ctx),
    createGoalListTool(ctx),
    createSetStatusTool(ctx),
  ]
}
