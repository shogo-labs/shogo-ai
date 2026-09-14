// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from 'child_process'

export interface PackagePoolJob {
  name: string
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface PackagePoolResult {
  job: PackagePoolJob
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

type OnComplete = (result: PackagePoolResult) => void | Promise<void>

function runJob(job: PackagePoolJob): Promise<PackagePoolResult> {
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const child = spawn(job.command, job.args, {
      cwd: job.cwd,
      env: job.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      resolve({
        job,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      })
    }

    child.on('error', (error) => {
      stderr += `${error}\n`
      finish(1)
    })
    child.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}

/**
 * Run independent package commands through a bounded worker pool.
 *
 * Each child gets its own process and its output is buffered until that child
 * finishes. The completion callback can then print the whole package result
 * as one grouped block, avoiding interleaved logs from concurrent jobs.
 */
export async function runPackagePool(
  jobs: readonly PackagePoolJob[],
  concurrency: number,
  onComplete?: OnComplete,
): Promise<PackagePoolResult[]> {
  if (!jobs.length) return []

  const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1
  const workerCount = Math.max(1, Math.min(requestedConcurrency, jobs.length))
  const results: PackagePoolResult[] = []
  let cursor = 0

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++
      if (index >= jobs.length) return

      const result = await runJob(jobs[index])
      results.push(result)
      await onComplete?.(result)
    }
  })

  await Promise.all(workers)
  return results
}
