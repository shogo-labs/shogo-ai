// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A channel's shared doc: loads it, autosaves local edits with the version
 * they were based on, and follows `doc.updated` events so other people's
 * saves appear live (or surface as a conflict while you have unsaved edits).
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { DocConflictError, teamChatApi, type ChannelDoc } from '../lib/team-chat-api'
import { useTeamChatEvents } from '../lib/team-chat-connection'
import {
  baseVersionOf,
  docReducer,
  initialDocState,
  isDirty,
  shouldSave,
  visibleDoc,
  type DocDraft,
} from '../lib/channel-doc-state'

const api = teamChatApi()
export const DOC_AUTOSAVE_MS = 1500

export function useConversationDoc(workspaceId: string | null | undefined, conversationId: string | null | undefined) {
  const [state, dispatch] = useReducer(docReducer, initialDocState)
  const stateRef = useRef(state)
  stateRef.current = state
  /** Highest version announced while a save was in flight; checked once it settles. */
  const pendingRemote = useRef(0)

  const fetchDoc = useCallback(
    async () => (conversationId ? api.getDoc(conversationId) : null),
    [conversationId],
  )

  const load = useCallback(async () => {
    try {
      const result = await fetchDoc()
      if (result) dispatch({ type: 'loaded', doc: result.doc, canEdit: result.canEdit, canManage: result.canManage })
    } catch (err) {
      dispatch({ type: 'save-error', error: err instanceof Error ? err.message : 'Could not load the doc' })
    }
  }, [fetchDoc])

  const pullRemote = useCallback(async () => {
    try {
      const result = await fetchDoc()
      if (!result) return
      if (!stateRef.current.loaded) {
        dispatch({ type: 'loaded', doc: result.doc, canEdit: result.canEdit, canManage: result.canManage })
        return
      }
      dispatch({ type: 'remote', doc: result.doc })
      // Lock state or role changes can flip editability.
      dispatch({ type: 'permissions', canEdit: result.canEdit, canManage: result.canManage })
    } catch {
      // The next event or reconnect retries.
    }
  }, [fetchDoc])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    const current = stateRef.current
    if (!conversationId || !shouldSave(current) || !current.draft) return
    const draft = current.draft
    dispatch({ type: 'save-start' })
    try {
      const doc = await api.saveDoc(conversationId, { ...draft, baseVersion: baseVersionOf(current) })
      dispatch({ type: 'save-ok', doc })
      settleRemote(doc)
    } catch (err) {
      if (err instanceof DocConflictError) {
        dispatch({ type: 'save-conflict', theirs: err.current })
      } else {
        dispatch({ type: 'save-error', error: err instanceof Error ? err.message : 'Could not save the doc' })
      }
      pendingRemote.current = 0
    }
  }, [conversationId])

  function settleRemote(saved: ChannelDoc) {
    const pending = pendingRemote.current
    pendingRemote.current = 0
    if (pending > saved.version) void pullRemote()
  }

  // Debounced autosave whenever the draft changes.
  useEffect(() => {
    if (!shouldSave(state)) return
    const timer = setTimeout(() => void save(), DOC_AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [state.draft, state.saving, state.conflict, state.server, state.canEdit, save])

  useTeamChatEvents(workspaceId, (event) => {
    if (event.type === 'ready') {
      void pullRemote()
      return
    }
    if (event.type !== 'doc.updated' || event.conversationId !== conversationId) return
    const current = stateRef.current
    if (current.saving) {
      pendingRemote.current = Math.max(pendingRemote.current, event.version)
      return
    }
    const server = current.server
    if (server && event.version <= server.version && event.locked === server.locked) return
    void pullRemote()
  })

  const edit = useCallback((patch: Partial<DocDraft>) => dispatch({ type: 'edit', patch }), [])
  const resolve = useCallback((choice: 'theirs' | 'overwrite') => dispatch({ type: 'resolve', choice }), [])

  const flush = useCallback(() => save(), [save])

  const setLocked = useCallback(async (locked: boolean) => {
    if (!conversationId) return
    const doc = await api.lockDoc(conversationId, locked)
    dispatch({ type: 'remote', doc })
  }, [conversationId])

  const restore = useCallback(async (revisionId: string) => {
    if (!conversationId) return
    try {
      const doc = await api.restoreDocRevision(conversationId, revisionId, baseVersionOf(stateRef.current))
      dispatch({ type: 'reset', doc })
    } catch (err) {
      if (err instanceof DocConflictError) dispatch({ type: 'save-conflict', theirs: err.current })
      else throw err
    }
  }, [conversationId])

  return {
    state,
    doc: visibleDoc(state),
    dirty: isDirty(state),
    edit,
    flush,
    resolve,
    setLocked,
    restore,
    reload: load,
  }
}
