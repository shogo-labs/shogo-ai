// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Request body for a chat turn. Shared by `ChatPanel` and the desktop island
 * so a turn started from either surface reaches the runtime with the same
 * model, interaction mode, and confirmed-plan handling.
 */
import type { PlanData } from "../components/chat/PlanCard"

export type ChatSendInteractionMode = "agent" | "plan" | "ask"

/**
 * Client-generated turn idempotency id, forwarded as `X-Client-Turn-Id`
 * (see `useChatTransport.ts`). Not a real UUID — `crypto.randomUUID` isn't
 * reliably available across every Hermes/web/native runtime this file ships
 * on — just unique enough to de-dupe retries of one logical send against
 * `apps/api/src/lib/chat-turn-idempotency.ts`.
 */
export function generateClientTurnId(): string {
  return `ctid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizePlanFilepath(filepath?: string | null): string | undefined {
  if (!filepath) return undefined
  const normalized = filepath.replace(/^\/+/, "").replace(/\\/g, "/")
  const filename = normalized.split("/").pop()
  if (!filename || !/^[a-zA-Z0-9._-]+\.plan\.md$/.test(filename))
    return undefined
  return `.shogo/plans/${filename}`
}

export function normalizePlanData(plan: PlanData): PlanData {
  return {
    ...plan,
    todos: plan.todos ?? [],
    filepath: normalizePlanFilepath(plan.filepath),
    summary: plan.summary,
    summaryStatus: plan.summaryStatus,
  }
}

export interface ChatSendBodyInput {
  chatSessionId: string | null | undefined
  chatSessionName?: string
  projectId?: string | null
  focusedProjectId?: string | null
  workspaceId?: string | null
  userId?: string | null
  featureId?: string | null
  phase?: string | null
  agentMode: string
  interactionMode: ChatSendInteractionMode
  dualPlan?: boolean
  clientTurnId?: string
  viewer?: unknown
  /** A plan the user just confirmed. Forces agent mode for this turn. */
  confirmedPlan?: PlanData | null
  ideContext?: unknown
  references?: readonly unknown[]
  /** Merged last, so callers can override any field. */
  extra?: Record<string, unknown>
}

export function buildChatSendBody(input: ChatSendBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    featureId: input.featureId,
    phase: input.phase,
    chatSessionId: input.chatSessionId,
    chatSessionName: input.chatSessionName || undefined,
    workspaceId: input.workspaceId,
    userId: input.userId,
    projectId: input.projectId,
    focusedProjectId: input.focusedProjectId,
    agentMode: input.agentMode,
    interactionMode: input.interactionMode,
    dualPlan: input.dualPlan,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(input.clientTurnId !== undefined ? { clientTurnId: input.clientTurnId } : {}),
    ...(input.viewer !== undefined ? { viewer: input.viewer } : {}),
  }
  if (input.confirmedPlan) {
    body.confirmedPlan = normalizePlanData(input.confirmedPlan)
    body.interactionMode = "agent"
  }
  if (input.ideContext) body.ideContext = input.ideContext
  if (input.references && input.references.length > 0) body.references = input.references
  if (input.extra) Object.assign(body, input.extra)
  return body
}
