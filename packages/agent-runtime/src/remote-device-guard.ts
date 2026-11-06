// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The gate in front of `/agent/remote/tool` when the call comes from another
 * of the person's runtimes (SHO-329).
 *
 * Two things have to hold before this computer runs work for a call it did
 * not start:
 *
 * 1. The person turned it on. `remoteTools` in Computer & files is off until
 *    they say otherwise, and nothing runs while it is off.
 * 2. A tool that changes something is approved at the computer being asked.
 *    The opt-in is a blanket yes for reading; `exec` and the write tools name
 *    the machine they would touch and wait for the person to agree, whatever
 *    the security mode says — full autonomy is about this computer's own
 *    agent, not about work another runtime asked for.
 *
 * Every one of those requests asks, including one with the same arguments as a
 * call this computer's own agent was already allowed, and a request that
 * arrives while no window is open waits for one instead of being refused
 * (SHO-333).
 */

import { REMOTE_DEVICE_MUTATING_TOOLS } from '@shogo/shared-runtime/remote-device-call'
import type { PermissionCategory } from './types'
import type { LocalAccessPolicy } from './local-access'
import type { ApprovalOutcome } from './permission-engine'

/** Where the person flips the switch, in the words the settings screen uses. */
export const REMOTE_DEVICE_TOOLS_SETTING = 'Settings > Computer and files'

export type RemoteDeviceGuardCode =
  | 'remote_device_tools_disabled'
  | 'remote_device_tool_denied'
  | 'remote_approval_unavailable'
  | 'remote_approval_timeout'

export type RemoteDeviceGuardResult =
  | { ok: true }
  | { ok: false; status: 403; code: RemoteDeviceGuardCode; message: string }

/** How the approval request at this computer was answered. */
export type RemoteApprovalAnswer = ApprovalOutcome

export interface RemoteDeviceGuardInput {
  tool: string
  args: Record<string, unknown>
  /** The running runtime's own Computer & files policy. */
  policy: LocalAccessPolicy | undefined
  /** Ask the person at this computer; answers why, not just yes or no. */
  requestApproval: (tool: string, args: Record<string, unknown>) => Promise<RemoteApprovalAnswer>
}

/** The approval card a remote tool raises, categorised like the tool's own gate. */
export function remoteDeviceApprovalCategory(tool: string): PermissionCategory {
  if (tool === 'delete_file') return 'file_delete'
  if (tool === 'write_file' || tool === 'edit_file') return 'file_write'
  return 'shell'
}

export async function guardRemoteDeviceCall(input: RemoteDeviceGuardInput): Promise<RemoteDeviceGuardResult> {
  const { tool, args, policy, requestApproval } = input

  if (policy?.remoteTools !== true) {
    return {
      ok: false,
      status: 403,
      code: 'remote_device_tools_disabled',
      message: `This computer does not let other devices run tools on it. Turn on "Let my other devices run tools on this computer" in ${REMOTE_DEVICE_TOOLS_SETTING} to allow it.`,
    }
  }

  if (!REMOTE_DEVICE_MUTATING_TOOLS.has(tool)) return { ok: true }

  const answer = await requestApproval(tool, args)
  if (answer === 'approved') return { ok: true }

  if (answer === 'timeout') {
    return {
      ok: false,
      status: 403,
      code: 'remote_approval_timeout',
      message: `The request to run ${tool} on this computer waited for someone to approve it and timed out. Open Shogo on that computer to approve it, then try again.`,
    }
  }
  if (answer === 'unavailable') {
    return {
      ok: false,
      status: 403,
      code: 'remote_approval_unavailable',
      message: `The request to run ${tool} on this computer could not reach a Shogo window to approve it. Open Shogo on that computer and try again.`,
    }
  }
  return {
    ok: false,
    status: 403,
    code: 'remote_device_tool_denied',
    message: `The request to run ${tool} on this computer was not approved. Ask the person at this computer to approve it in the Shogo window.`,
  }
}
