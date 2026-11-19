// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The model half of an access policy row, as the editor edits it (SHO-448).
 *
 * A stored row has three model states, and the editor has to round-trip all
 * three without inventing a fourth:
 *
 *   all     `modelTiers = null, modelIds = null` — every model under the
 *           workspace ceiling, including models added to the catalog later.
 *   tiers   an explicit tier list.
 *   models  an explicit model-id list.
 *
 * A fourth stored value — explicit empty arrays, which is how an ability-only
 * grant is written — is shown as `tiers` with nothing selected, and the screen
 * says so rather than pretending it is "all".
 *
 * The old editor expanded `null`/`null` into "every tier the catalog has
 * today", so opening a row and pressing save silently narrowed it to today's
 * tiers. Nothing here reads the catalog: a mode is a mode, and only the write
 * decides what the server stores.
 */

export type ModelGrantMode = 'all' | 'tiers' | 'models'

export interface ModelGrantFields {
  modelTiers: string[] | null
  modelIds: string[] | null
}

/** Which of the three states a stored row is in. */
export function modelGrantMode(row: ModelGrantFields): ModelGrantMode {
  if (row.modelTiers == null && row.modelIds == null) return 'all'
  if ((row.modelIds?.length ?? 0) > 0) return 'models'
  return 'tiers'
}

/** One line for the policy list, so an admin can see which state a row is in. */
export function describeModelGrant(row: ModelGrantFields): string {
  const mode = modelGrantMode(row)
  if (mode === 'all') return 'all models under the ceiling'
  if (mode === 'models') {
    const count = row.modelIds?.length ?? 0
    return `${count} ${count === 1 ? 'model' : 'models'}`
  }
  const tiers = row.modelTiers ?? []
  return tiers.length === 0 ? 'no models' : `tiers ${tiers.join(', ')}`
}

/**
 * The body fields for one mode. The column the mode does not use is always
 * cleared, so a row can never carry both a tier list and an id list, and
 * `grantsAllModels` is the only way to ask for "everything" — an empty
 * selection stays an empty selection.
 */
export function modelGrantWrite(
  mode: ModelGrantMode,
  tiers: readonly string[],
  ids: readonly string[],
): ModelGrantFields & { grantsAllModels: boolean } {
  if (mode === 'all') return { grantsAllModels: true, modelTiers: null, modelIds: null }
  if (mode === 'models') return { grantsAllModels: false, modelTiers: null, modelIds: [...ids] }
  return { grantsAllModels: false, modelTiers: [...tiers], modelIds: null }
}

/**
 * What an empty selection means, which differs by subject: a role row replaces
 * the role's models, while a group or member row only ever adds to them.
 */
export function emptySelectionHint(subjectType: 'role' | 'group' | 'member'): string {
  return subjectType === 'role'
    ? 'No models — this role can use none.'
    : "No models — this row adds none; the role's models still apply."
}
