// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

type Listener = (sessionId: string) => void
type ScopeListener = (sessionId: string) => void

const primarySessions = new Map<string, string>()
const listeners = new Map<string, Set<Listener>>()
const scopeListeners = new Map<string, Set<ScopeListener>>()

export function publishPrimaryWorkspaceSession(workspaceId: string, sessionId: string) {
  primarySessions.set(workspaceId, sessionId)
  listeners.get(workspaceId)?.forEach((listener) => listener(sessionId))
}

export function getKnownPrimaryWorkspaceSession(workspaceId: string): string | null {
  return primarySessions.get(workspaceId) ?? null
}

export function subscribePrimaryWorkspaceSession(workspaceId: string, listener: Listener) {
  const workspaceListeners = listeners.get(workspaceId) ?? new Set<Listener>()
  workspaceListeners.add(listener)
  listeners.set(workspaceId, workspaceListeners)
  return () => {
    workspaceListeners.delete(listener)
    if (workspaceListeners.size === 0) listeners.delete(workspaceId)
  }
}

export function publishWorkspaceSessionScopeChanged(workspaceId: string, sessionId: string) {
  scopeListeners.get(workspaceId)?.forEach((listener) => listener(sessionId))
}

export function subscribeWorkspaceSessionScopeChanged(workspaceId: string, listener: ScopeListener) {
  const workspaceListeners = scopeListeners.get(workspaceId) ?? new Set<ScopeListener>()
  workspaceListeners.add(listener)
  scopeListeners.set(workspaceId, workspaceListeners)
  return () => {
    workspaceListeners.delete(listener)
    if (workspaceListeners.size === 0) scopeListeners.delete(workspaceId)
  }
}
