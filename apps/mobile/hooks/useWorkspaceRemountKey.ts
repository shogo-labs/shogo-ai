// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useRef } from 'react'
import {
  INITIAL_WORKSPACE_REMOUNT_STATE,
  nextWorkspaceRemountState,
  workspaceRemountKey,
} from '../lib/workspace-remount-key'

/** See `lib/workspace-remount-key.ts`: a key that survives the cold-start load. */
export function useWorkspaceRemountKey(workspaceId: string | null | undefined): string {
  const state = useRef(INITIAL_WORKSPACE_REMOUNT_STATE)
  // Pure and idempotent for a given id, so updating during render is safe
  // under StrictMode's double render.
  state.current = nextWorkspaceRemountState(state.current, workspaceId)
  return workspaceRemountKey(state.current)
}
