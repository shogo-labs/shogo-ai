/**
 * Docker Sandbox Execution
 *
 * Wraps shell commands in ephemeral Docker containers for isolation.
 * Non-main sessions run commands inside a sandboxed container with:
 * - Workspace directory mounted read-write
 * - No network by default
 * - Resource limits (memory, CPU)
 * - Automatic container cleanup (--rm)
 */

import { execSync } from 'child_process'
import type { SandboxConfig } from './types'

const DEFAULT_SANDBOX: SandboxConfig = {
  enabled: process.env.SANDBOX_EXEC_ENABLED === 'true' || !!process.env.KUBERNETES_SERVICE_HOST,
  mode: 'non-main',
  image: process.env.SANDBOX_IMAGE || 'ubuntu:22.04',
  networkEnabled: false,
  memoryLimit: '256m',
  cpuLimit: '0.5',
}

export interface SandboxExecOptions {
  command: string
  workspaceDir: string
  timeout?: number
  sandboxConfig?: Partial<SandboxConfig>
  sessionId?: string
  mainSessionIds?: string[]
}

export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
  sandboxed: boolean
}

function shouldSandbox(opts: SandboxExecOptions): boolean {
  const config = { ...DEFAULT_SANDBOX, ...opts.sandboxConfig }
  if (!config.enabled) return false

  if (config.mode === 'all') return true

  if (config.mode === 'non-main' && opts.sessionId) {
    const mainIds = opts.mainSessionIds || []
    return !mainIds.includes(opts.sessionId)
  }

  return false
}

export function sandboxExec(opts: SandboxExecOptions): SandboxExecResult {
  const useSandbox = shouldSandbox(opts)

  if (!useSandbox) {
    return nativeExec(opts.command, opts.workspaceDir, opts.timeout)
  }

  const config = { ...DEFAULT_SANDBOX, ...opts.sandboxConfig }

  const dockerArgs = [
    'docker', 'run', '--rm',
    '-v', `${opts.workspaceDir}:/workspace`,
    '-w', '/workspace',
    '--memory', config.memoryLimit,
    '--cpus', config.cpuLimit,
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
  ]

  if (!config.networkEnabled) {
    dockerArgs.push('--network', 'none')
  }

  dockerArgs.push(config.image, 'bash', '-c', opts.command)

  try {
    const stdout = execSync(dockerArgs.join(' '), {
      timeout: opts.timeout || 30000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    })
    return { stdout: stdout.trim(), stderr: '', exitCode: 0, sandboxed: true }
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status ?? 1,
      sandboxed: true,
    }
  }
}

function nativeExec(command: string, cwd: string, timeout?: number): SandboxExecResult {
  try {
    const stdout = execSync(command, {
      cwd,
      timeout: timeout || 30000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    })
    return { stdout: stdout.trim(), stderr: '', exitCode: 0, sandboxed: false }
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status ?? 1,
      sandboxed: false,
    }
  }
}
