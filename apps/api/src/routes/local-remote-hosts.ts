// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Desktop-only Remote-SSH routes.
 *
 * Remote paths are metadata on this machine. This module never calls stat,
 * realpath, or any other local filesystem API for a remote folder; all
 * filesystem checks and listings are performed by the SSH host.
 */

import { Hono } from 'hono'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { prisma } from '../lib/prisma'
import { detectRemotePlatform, type RemotePlatform } from '../lib/remote-ssh/bootstrap'
import {
  commandSucceeded,
  remotePathExpression,
  type RemoteCommandRunner,
} from '../lib/remote-ssh/shell'
import { folderDisplayName, resolveFolderProjectWorkspace } from './local-projects'

const REMOTE_HOST_SELECT = {
  id: true,
  label: true,
  sshTarget: true,
  port: true,
  identityFile: true,
  platform: true,
  lastConnectedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

const MAX_LABEL_LENGTH = 200
const MAX_SSH_TARGET_LENGTH = 512
const MAX_IDENTITY_FILE_LENGTH = 4096
const MAX_BROWSE_ENTRIES = 2_000
const MAX_SSH_CONFIG_INCLUDE_DEPTH = 5

export interface RemoteHostRouteHost {
  id?: string
  label: string
  sshTarget: string
  port?: number | null
  identityFile?: string | null
  platform?: string | null
  lastConnectedAt?: Date | string | null
  createdAt?: Date | string | null
  updatedAt?: Date | string | null
}

export interface RemoteHostConnection extends RemoteCommandRunner {
  connect(): Promise<void>
  status?(): Promise<{ connected: boolean; state?: string }>
}

/** The RuntimeManager surface these routes use; it owns every SSH connection. */
export interface RemoteHostsRuntime {
  getRemoteConnection(remoteHostId: string, host: RemoteHostRouteHost): RemoteHostConnection
  getExistingRemoteConnection(remoteHostId: string): RemoteHostConnection | null
  getRemoteAskpassPrompt(remoteHostId: string): { prompt: string; createdAt: number } | null
  respondRemoteAskpass(remoteHostId: string, answer: string): void
  resetRemoteHost(remoteHostId: string): Promise<void>
  status?(projectId: string): unknown
  start?(projectId: string): Promise<unknown>
}

export interface LocalRemoteHostsRouteDependencies {
  runtimeManager: RemoteHostsRuntime
  detectPlatform?: (connection: RemoteCommandRunner) => Promise<RemotePlatform>
  readSshConfig?: () => Promise<string | null>
  prewarmRuntime?: (projectId: string) => Promise<unknown>
  prisma?: any
}

type RemoteHostRow = RemoteHostRouteHost & { id: string }

interface RemoteHostInput {
  label?: string
  sshTarget?: string
  port?: number | null
  identityFile?: string | null
}

function authUserId(c: any): string | null {
  const auth = c.get('auth' as never) as { userId?: string } | undefined
  return typeof auth?.userId === 'string' && auth.userId ? auth.userId : null
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function containsUnsafeControl(value: string): boolean {
  return value.includes('\u0000') || /[\r\n]/.test(value)
}

/**
 * Validate a create (`partial: false`) or update (`partial: true`) body.
 * On update, `null` clears the optional `port` / `identityFile` fields.
 */
function parseRemoteHostInput(
  body: Record<string, unknown>,
  partial: boolean,
): { ok: true; value: RemoteHostInput } | { ok: false; error: string } {
  const value: RemoteHostInput = {}

  if (body.label !== undefined || !partial) {
    if (!isNonEmptyString(body.label, MAX_LABEL_LENGTH) || containsUnsafeControl(body.label)) {
      return { ok: false, error: 'invalid_label' }
    }
    value.label = body.label.trim()
  }
  if (body.sshTarget !== undefined || !partial) {
    if (
      !isNonEmptyString(body.sshTarget, MAX_SSH_TARGET_LENGTH) ||
      containsUnsafeControl(body.sshTarget) ||
      /\s/.test(body.sshTarget.trim())
    ) {
      return { ok: false, error: 'invalid_ssh_target' }
    }
    value.sshTarget = body.sshTarget.trim()
  }
  if (body.port !== undefined) {
    if (body.port === null && partial) {
      value.port = null
    } else if (
      typeof body.port === 'number' &&
      Number.isInteger(body.port) &&
      body.port >= 1 &&
      body.port <= 65_535
    ) {
      value.port = body.port
    } else {
      return { ok: false, error: 'invalid_port' }
    }
  }
  if (body.identityFile !== undefined) {
    if (body.identityFile === null && partial) {
      value.identityFile = null
    } else if (
      typeof body.identityFile !== 'string' ||
      !body.identityFile.trim() ||
      body.identityFile.length > MAX_IDENTITY_FILE_LENGTH ||
      containsUnsafeControl(body.identityFile) ||
      /-----BEGIN .*PRIVATE KEY-----/.test(body.identityFile)
    ) {
      return { ok: false, error: 'invalid_identity_file' }
    } else {
      value.identityFile = body.identityFile.trim()
    }
  }
  return { ok: true, value }
}

function safeDate(value: unknown): string | null | undefined {
  if (value == null) return value as null | undefined
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : undefined
}

/**
 * Explicitly project the response. In particular, never spread a Prisma row
 * into an API response: a future schema field must not accidentally expose a
 * credential or key blob.
 */
function safeHost(
  row: RemoteHostRouteHost,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(row.id ? { id: row.id } : {}),
    label: row.label,
    sshTarget: row.sshTarget,
    ...(row.port == null ? {} : { port: row.port }),
    ...(row.identityFile ? { identityFile: row.identityFile } : {}),
    ...(row.platform ? { platform: row.platform } : {}),
    ...(row.lastConnectedAt !== undefined
      ? { lastConnectedAt: safeDate(row.lastConnectedAt) }
      : {}),
    ...(row.createdAt !== undefined ? { createdAt: safeDate(row.createdAt) } : {}),
    ...(row.updatedAt !== undefined ? { updatedAt: safeDate(row.updatedAt) } : {}),
    ...extras,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function testRemoteDirectoryCommand(remotePath: string): string {
  return ['set -eu', `remote_path=${remotePathExpression(remotePath)}`, 'test -d "$remote_path"'].join('\n')
}

function listRemoteDirectoriesCommand(remotePath: string): string {
  // Shell globs are expanded by the remote shell after the base path has
  // already been safely assigned. The directory test prevents files and
  // unmatched glob literals from entering the response. NUL framing keeps
  // names containing whitespace/newlines unambiguous.
  return [
    'set -eu',
    `base=${remotePathExpression(remotePath)}`,
    'test -d "$base"',
    'for child in "$base"/* "$base"/.[!.]* "$base"/..?*; do',
    '  if test -d "$child"; then printf "%s\\0" "$child"; fi',
    'done',
  ].join('\n')
}

function basenameRemotePath(path: string): string {
  const withoutTrailingSlash = path.replace(/\/+$/, '')
  return withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf('/') + 1) || '/'
}

function parseNulSeparatedDirectories(stdout: string): Array<{ name: string; path: string }> {
  return stdout
    .split('\u0000')
    .filter(Boolean)
    .slice(0, MAX_BROWSE_ENTRIES)
    .map((path) => ({ name: basenameRemotePath(path), path }))
}

interface ParsedSshAlias {
  alias: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
}

/**
 * Parse only explicit Host aliases and the connection options useful to the
 * picker. Wildcard/default blocks and `Match` blocks are intentionally
 * ignored; they often contain policy directives rather than a connectable
 * host. `Include` must already be expanded (see readSshConfigWithIncludes).
 */
export function parseSshConfigAliases(text: string): ParsedSshAlias[] {
  const aliases: ParsedSshAlias[] = []
  let current: ParsedSshAlias[] = []
  let options: Partial<ParsedSshAlias> = {}

  const flush = () => {
    for (const currentAlias of current) {
      aliases.push({
        alias: currentAlias.alias,
        ...(options.hostName ? { hostName: options.hostName } : {}),
        ...(options.user ? { user: options.user } : {}),
        ...(options.port ? { port: options.port } : {}),
        ...(options.identityFile ? { identityFile: options.identityFile } : {}),
      })
    }
    current = []
    options = {}
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutComment = line.replace(/\s+#.*$/, '')
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*?)\s*$/.exec(withoutComment)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')

    if (key === 'host') {
      flush()
      current = value
        .split(/\s+/)
        .filter((alias) => alias && !/[*?!]/.test(alias))
        .map((alias) => ({ alias }))
      continue
    }
    if (key === 'match') {
      // Options under Match apply conditionally; never attribute them to
      // the preceding Host block.
      flush()
      continue
    }
    if (current.length === 0) continue

    if (key === 'hostname' && !options.hostName) options.hostName = value
    else if (key === 'user' && !options.user) options.user = value
    else if (key === 'port' && !options.port) {
      const port = Number(value)
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) options.port = port
    } else if (key === 'identityfile' && !options.identityFile) {
      // The configured path is safe to return; file contents are never read.
      options.identityFile = value
    }
  }
  flush()
  return aliases
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

async function expandIncludePattern(pattern: string, sshDir: string): Promise<string[]> {
  const expanded = pattern.startsWith('~/') ? join(homedir(), pattern.slice(2)) : pattern
  const absolute = isAbsolute(expanded) ? expanded : join(sshDir, expanded)
  const name = basename(absolute)
  if (!/[*?]/.test(name)) return [absolute]
  try {
    const matcher = globToRegExp(name)
    const entries = await readdir(dirname(absolute))
    return entries
      .filter((entry) => matcher.test(entry))
      .sort()
      .map((entry) => join(dirname(absolute), entry))
  } catch {
    return []
  }
}

/**
 * Read an ssh_config file, inlining `Include` directives the way OpenSSH
 * resolves them (relative paths are relative to ~/.ssh, globs are sorted).
 */
export async function readSshConfigWithIncludes(
  path: string,
  depth = 0,
  sshDir = join(homedir(), '.ssh'),
): Promise<string | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  if (depth >= MAX_SSH_CONFIG_INCLUDE_DEPTH) return text

  const lines: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const include = /^\s*include(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(rawLine)
    if (!include) {
      lines.push(rawLine)
      continue
    }
    for (const pattern of include[1]!.split(/\s+/).filter(Boolean)) {
      for (const file of await expandIncludePattern(pattern, sshDir)) {
        const included = await readSshConfigWithIncludes(file, depth + 1, sshDir)
        if (included) lines.push(included)
      }
    }
  }
  return lines.join('\n')
}

function aliasHost(alias: ParsedSshAlias): Record<string, unknown> {
  return safeHost(
    {
      label: alias.alias,
      // Keep the alias as the SSH target so OpenSSH can apply any additional
      // per-alias settings that are not persisted in the response.
      sshTarget: alias.alias,
      port: alias.port,
      identityFile: alias.identityFile,
    },
    {
      source: 'ssh-config',
      alias: alias.alias,
      ...(alias.hostName ? { hostName: alias.hostName } : {}),
      ...(alias.user ? { user: alias.user } : {}),
    },
  )
}

function normalizeHostForConnection(row: RemoteHostRow): RemoteHostRouteHost {
  return {
    id: row.id,
    label: String(row.label ?? ''),
    sshTarget: String(row.sshTarget ?? ''),
    port: row.port == null ? undefined : Number(row.port),
    identityFile: row.identityFile == null ? undefined : String(row.identityFile),
    platform: row.platform == null ? undefined : String(row.platform),
  }
}

async function readJsonObject(c: any): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch {
    return null
  }
}

export function localRemoteHostsRoutes(dependencies: LocalRemoteHostsRouteDependencies): Hono {
  const router = new Hono()
  const db = (dependencies.prisma ?? prisma) as any
  const remoteHostModel = db.remoteHost
  const runtime = dependencies.runtimeManager
  const detectPlatform = dependencies.detectPlatform ?? detectRemotePlatform
  const readConfig =
    dependencies.readSshConfig ?? (() => readSshConfigWithIncludes(join(homedir(), '.ssh', 'config')))

  const readRemoteHost = async (id: string): Promise<RemoteHostRow | null> => {
    if (!remoteHostModel?.findUnique) return null
    return remoteHostModel.findUnique({ where: { id }, select: REMOTE_HOST_SELECT })
  }

  const ensureConnected = async (
    host: RemoteHostRow,
    updateMetadata: boolean,
  ): Promise<{ connection: RemoteHostConnection; platform?: RemotePlatform }> => {
    const connection = runtime.getRemoteConnection(host.id, normalizeHostForConnection(host))
    await connection.connect()
    let platform: RemotePlatform | undefined
    // Detecting on every first use also repairs rows whose platform has not
    // yet been saved.
    if (updateMetadata || !host.platform) {
      platform = await detectPlatform(connection)
      if (updateMetadata && remoteHostModel?.update) {
        await remoteHostModel.update({
          where: { id: host.id },
          data: { platform: platform.target, lastConnectedAt: new Date() },
          select: REMOTE_HOST_SELECT,
        })
      }
    }
    return { connection, platform }
  }

  router.get('/remote-hosts', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    try {
      const savedRows: RemoteHostRow[] = remoteHostModel?.findMany
        ? await remoteHostModel.findMany({ orderBy: { label: 'asc' }, select: REMOTE_HOST_SELECT })
        : []
      const configText = await readConfig()
      const aliases = configText ? parseSshConfigAliases(configText).map(aliasHost) : []
      return c.json({
        hosts: [...savedRows.map((row) => safeHost(row, { source: 'saved' })), ...aliases],
      })
    } catch (error) {
      console.error('[local-remote-hosts] list failed:', error)
      return c.json({ error: 'remote_host_list_failed' }, 500)
    }
  })

  router.post('/remote-hosts', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const body = await readJsonObject(c)
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const input = parseRemoteHostInput(body, false)
    if (!input.ok) return c.json({ error: input.error }, 400)
    if (!remoteHostModel?.create) return c.json({ error: 'remote_hosts_unavailable' }, 503)

    try {
      const created = await remoteHostModel.create({ data: input.value, select: REMOTE_HOST_SELECT })
      return c.json({ host: safeHost(created, { source: 'saved' }) }, 201)
    } catch (error) {
      console.error('[local-remote-hosts] create failed:', error)
      return c.json({ error: 'remote_host_create_failed', message: errorMessage(error) }, 500)
    }
  })

  router.patch('/remote-hosts/:id', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)
    const body = await readJsonObject(c)
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const input = parseRemoteHostInput(body, true)
    if (!input.ok) return c.json({ error: input.error }, 400)

    const connectionChanged =
      (input.value.sshTarget !== undefined && input.value.sshTarget !== host.sshTarget) ||
      (input.value.port !== undefined && input.value.port !== (host.port ?? null)) ||
      (input.value.identityFile !== undefined && input.value.identityFile !== (host.identityFile ?? null))

    try {
      const updated = await remoteHostModel.update({
        where: { id },
        // A different machine may have a different architecture.
        data: connectionChanged ? { ...input.value, platform: null } : input.value,
        select: REMOTE_HOST_SELECT,
      })
      if (connectionChanged) await runtime.resetRemoteHost(id)
      return c.json({ host: safeHost(updated, { source: 'saved' }) })
    } catch (error) {
      console.error('[local-remote-hosts] update failed:', error)
      return c.json({ error: 'remote_host_update_failed', message: errorMessage(error) }, 500)
    }
  })

  router.delete('/remote-hosts/:id', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)

    const projectCount: number = await db.project.count({ where: { remoteHostId: id } })
    if (projectCount > 0) {
      return c.json({
        error: 'remote_host_in_use',
        message: 'Delete or move the projects on this host before removing it.',
        projectCount,
      }, 409)
    }
    try {
      await runtime.resetRemoteHost(id)
      await remoteHostModel.delete({ where: { id } })
      return c.json({ deleted: true })
    } catch (error) {
      // The FK is ON DELETE RESTRICT, so a project created concurrently
      // lands here instead of being orphaned.
      console.error('[local-remote-hosts] delete failed:', error)
      return c.json({ error: 'remote_host_delete_failed', message: errorMessage(error) }, 409)
    }
  })

  router.post('/remote-hosts/:id/connect', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)

    try {
      const result = await ensureConnected(host, true)
      const updated = await readRemoteHost(id)
      const status = result.connection.status ? await result.connection.status() : undefined
      return c.json({
        host: safeHost(updated ?? host, { source: 'saved' }),
        connected: status?.connected ?? true,
        state: status?.connected === false ? 'disconnected' : (status?.state ?? 'connected'),
        platform: result.platform?.target ?? updated?.platform ?? host.platform ?? null,
      })
    } catch (error) {
      console.warn(`[local-remote-hosts] connect failed for ${id}:`, errorMessage(error))
      return c.json({ error: 'remote_host_connect_failed', message: errorMessage(error) }, 503)
    }
  })

  router.get('/remote-hosts/:id/status', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)

    let connected = false
    let state = 'disconnected'
    const existing = runtime.getExistingRemoteConnection(id)
    if (existing?.status) {
      try {
        const status = await existing.status()
        connected = status.connected
        state = status.connected ? (status.state ?? 'connected') : 'disconnected'
      } catch {
        connected = false
        state = 'disconnected'
      }
    }

    let runtimes: Array<{ projectId: string; name?: string; status: string; agentPort?: number }> = []
    try {
      const projects = await db.project.findMany({
        where: { remoteHostId: id },
        select: { id: true, name: true },
      })
      runtimes = (projects ?? []).map((project: { id: string; name?: string }) => {
        const current = runtime.status?.(project.id) as
          | { status?: string; agentPort?: number }
          | null
          | undefined
        return {
          projectId: project.id,
          ...(project.name ? { name: project.name } : {}),
          status: current?.status ?? 'stopped',
          ...(current?.agentPort ? { agentPort: current.agentPort } : {}),
        }
      })
    } catch {
      // Runtime status is best-effort and must not turn a host status check
      // into a database availability failure.
    }

    return c.json({
      host: safeHost(host, { source: 'saved' }),
      connected,
      state,
      platform: host.platform ?? null,
      runtime: runtimes,
    })
  })

  router.get('/remote-hosts/:id/askpass', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)
    const prompt = runtime.getRemoteAskpassPrompt(id)
    return c.json({
      pending: !!prompt,
      ...(prompt ? { prompt: prompt.prompt, createdAt: prompt.createdAt } : {}),
    })
  })

  router.post('/remote-hosts/:id/askpass', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)
    const body = await readJsonObject(c)
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    if (
      typeof body.answer !== 'string' ||
      body.answer.length > 8_192 ||
      body.answer.includes('\u0000') ||
      /[\r\n]/.test(body.answer)
    ) {
      return c.json({ error: 'invalid_askpass_response' }, 400)
    }
    try {
      runtime.respondRemoteAskpass(id, body.answer)
      return c.json({ accepted: true })
    } catch (error) {
      return c.json({ error: 'remote_askpass_unavailable', message: errorMessage(error) }, 409)
    }
  })

  router.get('/remote-hosts/:id/browse', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)
    const requested = c.req.query('path')
    const path = requested === undefined || requested === '' ? '~' : requested
    if (path.includes('\u0000')) return c.json({ error: 'invalid_remote_path' }, 400)

    try {
      const { connection } = await ensureConnected(host, false)
      const result = await connection.exec(listRemoteDirectoriesCommand(path))
      if (!commandSucceeded(result)) {
        return c.json({ error: 'remote_directory_unavailable' }, 400)
      }
      return c.json({ path, entries: parseNulSeparatedDirectories(result.stdout) })
    } catch (error) {
      console.warn(`[local-remote-hosts] browse failed for ${id}:`, errorMessage(error))
      return c.json({ error: 'remote_browse_failed' }, 503)
    }
  })

  router.post('/projects/from-remote-folder', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: 'unauthenticated' }, 401)

    const body = await readJsonObject(c)
    if (!body) return c.json({ error: 'invalid_json' }, 400)

    // Local folder fields are rejected so callers cannot accidentally mix
    // local and remote project semantics.
    if (body.paths !== undefined || body.localPath !== undefined || body.remotePath !== undefined) {
      return c.json({ error: 'local_remote_path_mixing' }, 400)
    }
    if (!isNonEmptyString(body.remoteHostId, 256) || containsUnsafeControl(body.remoteHostId)) {
      return c.json({ error: 'remote_host_id_required' }, 400)
    }
    if (typeof body.path !== 'string' || !body.path.trim() || body.path.includes('\u0000')) {
      return c.json({ error: 'invalid_remote_path' }, 400)
    }
    if (body.workspaceId !== undefined && (
      typeof body.workspaceId !== 'string' ||
      !body.workspaceId.trim() ||
      containsUnsafeControl(body.workspaceId)
    )) {
      return c.json({ error: 'invalid_workspace_id' }, 400)
    }
    if (body.name !== undefined && (
      !isNonEmptyString(body.name, MAX_LABEL_LENGTH) ||
      containsUnsafeControl(body.name)
    )) {
      return c.json({ error: 'invalid_project_name' }, 400)
    }

    const remoteHostId = body.remoteHostId.trim()
    const remotePath = body.path.trim()
    const host = await readRemoteHost(remoteHostId)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)

    try {
      const { connection } = await ensureConnected(host, true)
      const directory = await connection.exec(testRemoteDirectoryCommand(remotePath))
      if (!commandSucceeded(directory)) {
        return c.json({ error: 'remote_path_not_directory' }, 400)
      }
    } catch (error) {
      console.warn(`[local-remote-hosts] remote folder verification failed for ${remoteHostId}:`, errorMessage(error))
      return c.json({ error: 'remote_host_connect_failed' }, 503)
    }

    const target = await resolveFolderProjectWorkspace(
      userId,
      typeof body.workspaceId === 'string' ? body.workspaceId.trim() : undefined,
    )
    if (!target) return c.json({ error: 'no_workspace_for_user' }, 400)

    const name =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim() : folderDisplayName(remotePath)

    let project: any
    try {
      project = await db.$transaction(async (tx: any) => {
        const created = await tx.project.create({
          data: {
            name,
            workspaceId: target.workspaceId,
            createdBy: userId,
            workingMode: 'external',
            runtimeEnabled: true,
            trustLevel: 'restricted',
            status: 'active',
            tier: 'starter',
            accessLevel: 'private',
            remoteHostId,
            settings: JSON.stringify({
              workingMode: 'external',
              canvasEnabled: false,
              activeMode: 'none',
            }),
          },
        })
        await tx.projectFolder.create({
          data: {
            projectId: created.id,
            path: remotePath,
            isPrimary: true,
            lastOpenedAt: new Date(),
          },
        })
        return created
      })
    } catch (error) {
      console.error('[local-remote-hosts] project create failed:', error)
      return c.json({ error: 'create_failed', message: errorMessage(error) }, 500)
    }

    const reloaded = db.project?.findUnique
      ? await db.project.findUnique({ where: { id: project.id }, include: { projectFolders: true } })
      : project

    const prewarm = dependencies.prewarmRuntime ?? runtime.start?.bind(runtime)
    if (prewarm) {
      void Promise.resolve().then(() => prewarm(project.id)).catch((error) => {
        console.warn(`[local-remote-hosts] prewarm failed for ${project.id}:`, errorMessage(error))
      })
    }

    return c.json(
      {
        project: reloaded,
        rebound: false,
        ...(target.redirectedFromWorkspaceId
          ? { redirectedFromWorkspaceId: target.redirectedFromWorkspaceId }
          : {}),
      },
      201,
    )
  })

  return router
}
