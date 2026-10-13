// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * State machine for editing a channel doc. `server` is the last doc the API
 * confirmed; `draft` holds local edits not yet saved (null when clean).
 * Saves send `baseVersion` (the server version the draft started from); when
 * someone else saved first, the doc enters `conflict` until the user picks
 * theirs or overwrites. Pure so it can be unit-tested; `useConversationDoc`
 * drives it.
 */
import type { ChannelDoc, DocAuthor } from './team-chat-api'

export interface DocDraft {
  title: string
  content: string
}

export interface DocState {
  loaded: boolean
  server: ChannelDoc | null
  draft: DocDraft | null
  /** Draft text currently being saved, so edits made during the request stay dirty. */
  saving: DocDraft | null
  conflict: { theirs: ChannelDoc | null } | null
  error: string | null
  canEdit: boolean
  canManage: boolean
}

export type DocAction =
  | { type: 'loaded'; doc: ChannelDoc | null; canEdit: boolean; canManage: boolean }
  /** Edit rights changed (lock toggled, role changed); the doc itself is untouched. */
  | { type: 'permissions'; canEdit: boolean; canManage: boolean }
  | { type: 'edit'; patch: Partial<DocDraft> }
  | { type: 'save-start' }
  | { type: 'save-ok'; doc: ChannelDoc }
  | { type: 'save-conflict'; theirs: ChannelDoc | null }
  | { type: 'save-error'; error: string }
  | { type: 'remote'; doc: ChannelDoc | null }
  | { type: 'resolve'; choice: 'theirs' | 'overwrite' }
  /** Adopt `doc` and drop local edits (after restoring a revision). */
  | { type: 'reset'; doc: ChannelDoc }

export const initialDocState: DocState = {
  loaded: false,
  server: null,
  draft: null,
  saving: null,
  conflict: null,
  error: null,
  canEdit: false,
  canManage: false,
}

export function baseVersionOf(state: Pick<DocState, 'server'>): number {
  return state.server?.version ?? 0
}

/** What the editor shows: local edits over the confirmed doc. */
export function visibleDoc(state: DocState): DocDraft {
  return state.draft ?? { title: state.server?.title ?? '', content: state.server?.content ?? '' }
}

export function isDirty(state: DocState): boolean {
  if (!state.draft) return false
  const s = state.server
  return state.draft.title !== (s?.title ?? '') || state.draft.content !== (s?.content ?? '')
}

/** Whether autosave should fire now. */
export function shouldSave(state: DocState): boolean {
  return state.loaded && state.canEdit && !state.saving && !state.conflict && isDirty(state)
}

function sameDraft(a: DocDraft | null, b: DocDraft | null): boolean {
  return !!a && !!b && a.title === b.title && a.content === b.content
}

function isNewer(doc: ChannelDoc | null, than: ChannelDoc | null): boolean {
  if (!doc) return false
  return !than || doc.version > than.version || doc.locked !== than.locked
}

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        loaded: true,
        server: state.server && action.doc && action.doc.version < state.server.version ? state.server : action.doc,
        canEdit: action.canEdit,
        canManage: action.canManage,
        error: null,
        draft: isDirty(state) ? state.draft : null,
      }
    case 'permissions':
      if (state.canEdit === action.canEdit && state.canManage === action.canManage) return state
      return { ...state, canEdit: action.canEdit, canManage: action.canManage }
    case 'edit': {
      const draft = { ...visibleDoc(state), ...action.patch }
      return { ...state, draft, error: null }
    }
    case 'save-start':
      return state.draft ? { ...state, saving: state.draft } : state
    case 'save-ok': {
      const unchanged = sameDraft(state.draft, state.saving)
      return { ...state, server: action.doc, saving: null, draft: unchanged ? null : state.draft, error: null }
    }
    case 'save-conflict':
      return { ...state, saving: null, conflict: { theirs: action.theirs } }
    case 'save-error':
      return { ...state, saving: null, error: action.error }
    case 'remote': {
      // While a save is in flight the update may be our own echo; the hook re-checks once it settles.
      if (state.saving || !isNewer(action.doc, state.server)) return state
      if (isDirty(state)) {
        if (action.doc && state.server && action.doc.version === state.server.version) {
          return { ...state, server: action.doc }
        }
        return { ...state, conflict: { theirs: action.doc } }
      }
      return { ...state, server: action.doc, draft: null }
    }
    case 'resolve': {
      if (!state.conflict) return state
      const theirs = state.conflict.theirs
      if (action.choice === 'theirs') return { ...state, server: theirs, draft: null, conflict: null }
      return { ...state, server: theirs, conflict: null }
    }
    case 'reset':
      return { ...state, server: action.doc, draft: null, saving: null, conflict: null, error: null }
  }
}

export function describeAuthor(author: DocAuthor | null | undefined): string {
  return author?.name ?? 'Someone'
}
