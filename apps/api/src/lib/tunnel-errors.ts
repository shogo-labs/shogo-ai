// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed tunnel failures, so a caller can tell "this machine is not connected"
 * from "this machine is connected but slow".
 *
 * Both used to surface as `Error('Instance is offline')`, and the machine relay
 * turned every one of them into `503 { code: 'offline' }`. A desktop that simply
 * took 31 s to answer therefore told the user its machine was offline — and, on
 * the way, deleted the tunnel's owner key (SHO-185).
 */

/** The tunnel owner answered our liveness probe but not the request in time. */
export class MachineTimeoutError extends Error {
  readonly code = 'machine_timeout'

  constructor(readonly instanceId: string, readonly timeoutMs: number) {
    super(`Machine did not answer within ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'MachineTimeoutError'
  }
}

/** The tunnel owner answered our liveness probe but its relay reply never came. */
export class RelayTimeoutError extends MachineTimeoutError {
  constructor(instanceId: string, timeoutMs: number) {
    super(instanceId, timeoutMs)
    this.name = 'RelayTimeoutError'
    this.message = `Machine did not answer within ${Math.round(timeoutMs / 1000)}s (relay)`
  }
}

export function isMachineTimeoutError(err: unknown): err is MachineTimeoutError {
  return err instanceof MachineTimeoutError
}
