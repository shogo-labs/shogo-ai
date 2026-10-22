// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-141 (#1634), red first: `cmd | tail -25` reported the exit code of
 * `tail`, so a failure in the left-hand stage of a pipeline was invisible.
 *
 * Every piped exec must report the pipeline's own status where the shell can
 * (`set -o pipefail`), and where it cannot (cmd.exe, or a `sh` that rejects
 * pipefail) the result must say the status is unavailable instead of printing
 * the last stage's number as if it were the command's.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  sandboxExecAsync,
  chooseShell,
  sandboxShellCommand,
  commandHasPipeline,
} from '../sandbox-exec'
import { settleOutcome, formatTaskNotification } from '../task-registry'

const IS_WINDOWS = process.platform === 'win32'

const dirs: string[] = []
function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sho141-pipe-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

async function run(command: string) {
  const handle = sandboxExecAsync({ command, workspaceDir: tmpWorkspace() })
  return handle.done
}

describe('a pipeline reports the pipeline, not its last stage', () => {
  test('a failing left-hand stage fails the command', async () => {
    if (IS_WINDOWS) return // cmd.exe cannot do this; covered by the shell probe
    const result = await run('false | cat')
    expect(result.exitCode).toBe(1)
    expect(result.exitCodeReliable).not.toBe(false)
  })

  test('a masked non-zero left-hand stage reports its own code', async () => {
    if (IS_WINDOWS) return
    const result = await run("sh -c 'exit 7' | tail -1")
    expect(result.exitCode).toBe(7)
  })

  test('a single command keeps its real exit code', async () => {
    if (IS_WINDOWS) return
    const result = await run("sh -c 'exit 3'")
    expect(result.exitCode).toBe(3)
  })

  test('SIGPIPE is a failure now, and that is the point', async () => {
    if (IS_WINDOWS) return
    // `yes` is killed by SIGPIPE once head exits: 141, not the 0 this used to
    // report. Locked deliberately — masking it would restore the bug.
    const result = await run('yes | head -1')
    expect(result.exitCode).toBe(141)
  })
})

describe('a shell without pipefail says the status is unavailable', () => {
  test('the container command always starts with set -o pipefail', () => {
    expect(sandboxShellCommand('bun test | tail -5')).toBe('set -o pipefail; bun test | tail -5')
  })

  test('a pipefail-capable shell is preferred over /bin/sh', () => {
    const plan = chooseShell({ platform: 'linux', candidates: ['/bin/sh', '/bin/bash'], probe: (s) => s.includes('bash') })
    expect(plan.shell).toBe('/bin/bash')
    expect(plan.pipefail).toBe(true)
  })

  test('Windows without Git-Bash falls back to cmd.exe, which has no pipefail', () => {
    const plan = chooseShell({ platform: 'win32', candidates: [], probe: () => false })
    expect(plan.shell).toBeNull()
    expect(plan.pipefail).toBe(false)
    expect(plan.label.toLowerCase()).toContain('cmd')
  })

  test('a pipeline is detected, a quoted or logical-or one is not', () => {
    expect(commandHasPipeline('false | cat')).toBe(true)
    expect(commandHasPipeline('false || true')).toBe(false)
    expect(commandHasPipeline(`echo 'a | b'`)).toBe(false)
  })

  test('a real piped exec through a pipefail-less shell reports no exit code', async () => {
    if (IS_WINDOWS) return
    // The exact cmd.exe shape, driven with a POSIX /bin/sh so it runs in CI:
    // the last stage succeeds, the command did not.
    const handle = sandboxExecAsync({
      command: 'false | cat',
      workspaceDir: tmpWorkspace(),
      shell: { platform: 'linux', candidates: ['/bin/sh'], probe: () => false },
    })
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(result.exitCodeReliable).toBe(false)
    expect(result.pipelineStatus).toBe('last-stage')

    const decision = settleOutcome({
      exitCode: result.exitCode,
      exitCodeReliable: result.exitCodeReliable,
      shellLabel: result.shellLabel,
    })
    expect(decision.exitCode).toBeUndefined()
    const note = formatTaskNotification({
      taskId: 't_pipe0001',
      source: 'shell',
      title: 'false | cat',
      status: decision.status,
      exitCode: decision.exitCode,
      exitCodeReliable: false,
      shellLabel: result.shellLabel,
      tail: '',
    })
    expect(note).toContain('pipeline status unavailable')
    expect(note).not.toContain('(exit code')
  })
})
