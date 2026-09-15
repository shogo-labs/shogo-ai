// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { AgentTaskStatus } from './api'

export function taskStatusLabel(status: AgentTaskStatus) {
  switch (status) {
    case 'draft': return 'Draft'
    case 'queued': return 'Queued'
    case 'running': return 'Running'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
    default: return status
  }
}

/** Keep implementation details out of the primary mobile task experience. */
export function readableAgentTaskError(value: string | null | undefined, fallback = 'The agent could not complete this task.') {
  const message = value?.trim()
  if (!message) return fallback
  if (/workspace_runtime_unavailable|workspace runtimes|pod_unavailable|agent-runtime exited|before becoming healthy/i.test(message)) {
    return 'The agent environment could not start. Please try again in a moment.'
  }
  if (/^\s*\{/.test(message) || /"(?:code|message|error)"\s*:/.test(message)) {
    return fallback
  }
  return message.length > 180 ? `${message.slice(0, 177)}…` : message
}
