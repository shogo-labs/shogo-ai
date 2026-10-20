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
import type { ChannelDoc, DocAuthor, DocBudget, DocBudgetLevel } from './team-chat-api'

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

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Mirrors the API's limit; the doc is injected into every agent prompt, so full docs are expensive. */
export const DOC_LIMIT = 200_000
export const DOC_WARN_PCT = 70
export const DOC_CRITICAL_PCT = 85

/** The doc's budget for the text in the editor (the server sends the saved one). */
export function docBudgetFor(content: string, limit = DOC_LIMIT): DocBudget {
  const chars = content.length
  const pct = limit > 0 ? Math.round((chars / limit) * 1000) / 10 : 0
  const level: DocBudgetLevel = chars >= (limit * DOC_CRITICAL_PCT) / 100
    ? 'critical'
    : chars >= (limit * DOC_WARN_PCT) / 100
      ? 'warn'
      : 'ok'
  return { chars, limit, pct, level }
}

/** `184,210 / 200,000` for the meter. */
export function formatDocBudget(budget: { chars: number; limit: number }): string {
  return `${budget.chars.toLocaleString('en-US')} / ${budget.limit.toLocaleString('en-US')}`
}

/** The doc's sections with the characters each occupies, for the "Archive a section" picker. */
export function docSections(content: string): Array<{ heading: string; chars: number }> {
  const lines = content.split('\n')
  const found: Array<{ heading: string; level: number; start: number; chars: number }> = []
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m && m[2].trim()) found.push({ heading: m[2].trim(), level: m[1].length, start: i, chars: 0 })
  })
  found.forEach((section, i) => {
    const next = found.slice(i + 1).find((s) => s.level <= section.level)
    const end = next ? next.start : lines.length
    section.chars = lines.slice(section.start, end).join('\n').replace(/\s+$/, '').length
  })
  return found.map(({ heading, chars }) => ({ heading, chars }))
}
