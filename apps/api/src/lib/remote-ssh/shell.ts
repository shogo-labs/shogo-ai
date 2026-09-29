// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Remote shell primitives shared by the Remote-SSH transport, bootstrapper,
 * runtime manager, and routes.
 */

import type { Readable } from 'node:stream'

export interface RemoteCommandResult {
  stdout: string
  stderr: string
  /** `null` means the local ssh process never produced a normal exit code. */
  exitCode: number | null
}

export interface RemoteExecOptions {
  /** Kill the local ssh process after this many milliseconds. */
  timeoutMs?: number
  /** Bytes written to the remote command's stdin. Never appears in argv. */
  input?: string | Readable
}

/** The minimal command surface used by the bootstrapper and routes. */
export interface RemoteCommandRunner {
  exec(command: string, options?: RemoteExecOptions): Promise<RemoteCommandResult>
}

/**
 * Quote one literal argument for the remote POSIX shell. Local process
 * arguments are passed to spawn() directly and must not use this.
 */
export function quoteRemoteShellArgument(value: string): string {
  if (value.includes('\u0000')) {
    throw new TypeError('Remote shell arguments cannot contain NUL bytes')
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Quote a remote path, expanding only a leading `~` / `~/` / `$HOME/` to the
 * remote user's home directory. Everything else is one quoted literal.
 */
export function remotePathExpression(remotePath: string): string {
  if (remotePath === '~') return '"$HOME"'
  if (remotePath.startsWith('~/')) {
    return `"$HOME/"${quoteRemoteShellArgument(remotePath.slice(2))}`
  }
  if (remotePath.startsWith('$HOME/')) {
    return `"$HOME/"${quoteRemoteShellArgument(remotePath.slice('$HOME/'.length))}`
  }
  return quoteRemoteShellArgument(remotePath)
}

export function commandSucceeded(result: RemoteCommandResult): boolean {
  return result.exitCode === 0
}

/** A short, user-presentable reason for a failed remote command. */
export function commandFailureDetail(result: RemoteCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim()
  if (detail) return detail.length > 500 ? `…${detail.slice(-500)}` : detail
  return result.exitCode === null ? 'ssh did not exit normally' : `exit code ${result.exitCode}`
}

export class RemoteCommandError extends Error {
  readonly operation: string
  readonly result: RemoteCommandResult

  constructor(operation: string, result: RemoteCommandResult) {
    super(`${operation} failed: ${commandFailureDetail(result)}`)
    this.name = 'RemoteCommandError'
    this.operation = operation
    this.result = result
  }
}

export async function execChecked(
  runner: RemoteCommandRunner,
  command: string,
  operation: string,
  options?: RemoteExecOptions,
): Promise<RemoteCommandResult> {
  const result = await runner.exec(command, options)
  if (!commandSucceeded(result)) throw new RemoteCommandError(operation, result)
  return result
}
