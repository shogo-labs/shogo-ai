// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The wire contract for one tool call that runs on a person's own paired
 * computer (SHO-285 Update 2, SHO-329).
 *
 * The API asks for it (`POST /api/internal/devices/:instanceId/remote-tool`),
 * carries it over the instance tunnel and the desktop's runtime serves it at
 * `/agent/remote/tool`. Both sides use these names so the desktop can tell a
 * call addressed to *its* computer from a project-to-project hop that happens
 * to land on the same route.
 */

/** Set by the API on the tunneled call; without it the route is the plain project hop. */
export const REMOTE_DEVICE_CALL_HEADER = 'x-shogo-remote-device'

/** The person the API checked owns this device, so the desktop can log who called. */
export const REMOTE_DEVICE_REQUESTER_HEADER = 'x-shogo-remote-requester'

/**
 * Tools that change things on the computer. A remote call with one of these
 * needs the desktop's explicit opt-in *and* an approval, whatever its security
 * mode says. Reads only need the opt-in.
 */
export const REMOTE_DEVICE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'exec',
  'exec_wait',
  'exec_list',
  'write_file',
  'edit_file',
  'delete_file',
])
