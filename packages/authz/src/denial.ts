// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one `ability_not_allowed` decision.
 *
 * Two layers refuse the same call: the runtime's per-turn tool gate (SHO-417)
 * and the internal route behind the tool. This is the shared decision both
 * report, so a tool that maps a server refusal keys on the code instead of
 * guessing the route's wording (SHO-539: publishing is a *project* permission,
 * so only the server can refuse it, and the tool has to recognise that).
 *
 * Each layer wraps it in its own shape: an HTTP route sends it as the API's
 * `{ error: { code, message } }` envelope; a tool result sends
 * `{ error: code, permission, message }` to the model, the same body
 * `withAbilityGate` produces.
 */

export interface AbilityDenial {
  code: 'ability_not_allowed'
  permission: string
  message: string
}

export function abilityDenial(permission: string, message?: string): AbilityDenial {
  return {
    code: 'ability_not_allowed',
    permission,
    message: message ?? `Ask a workspace admin for ${permission}.`,
  }
}
