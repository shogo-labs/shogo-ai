// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TeammateContext — AsyncLocalStorage for Teammate Identity Isolation
 *
 * Each in-process teammate runs in the same Node.js process but gets isolated
 * identity via AsyncLocalStorage, matching Claude Code's in-process backend.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface TeammateContext {
  agentId: string
  teamId: string
  name: string
  color?: string
  isLeader: boolean
}

export const teammateStorage = new AsyncLocalStorage<TeammateContext>()

export function getTeammateContext(): TeammateContext | undefined {
  return teammateStorage.getStore()
}

export function formatAgentId(name: string, teamId: string): string {
  return `${name}@${teamId}`
}
