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
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../lib/prisma'
import {
  createSSHConnection,
  quoteRemoteShellArgument,
  type SSHCommandResult,
} from '../lib/remote-ssh/connection'
import { detectRemotePlatform, type RemotePlatform } from '../lib/remote-ssh/bootstrap'
import { resolveFolderProjectWorkspace } from './local-projects'

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

export interface RemoteHostConnection {
  connect(): Promise<void>
  exec(command: string): Promise<SSHCommandResult | {
    stdout: string
    stderr?: string
    exitCode?: number | null
    code?: number
    status?: number
  }>
  status?: () => Promise<{
    connected: boolean
    state?: string
    host?: string
    controlPath?: string
  }>
}

export interface LocalRemoteHostsRouteDependencies {
  /**
   * RuntimeManager's public connection seam. Tests and embedders can inject
   * this instead of starting a real SSH process.
   */
  runtimeManager?: {
    getRemoteConnection?: (
      remoteHostId: string,
      host: RemoteHostRouteHost,
    ) => RemoteHostConnection
    getExistingRemoteConnection?: (remoteHostId: string) => RemoteHostConnection | null
    getRemoteConnectionStatus?: (remoteHostId: string) => Promise<{
      connected: boolean
      state?: string
      host?: string
      controlPath?: string
    } | null>
    getRemoteAskpassPrompt?: (remoteHostId: string) => {
      prompt: string
      createdAt: number
    } | null
    respondRemoteAskpass?: (remoteHostId: string, answer: string) => void
    status?: (projectId: string) => unknown
    start?: (projectId: string) => Promise<unknown>
  }
  /** Alternate seam for route-level tests and host-specific integrations. */
  connectionForHost?: (
    remoteHostId: string,
    host: RemoteHostRouteHost,
  ) => RemoteHostConnection
  detectPlatform?: (connection: RemoteHostConnection) => Promise<RemotePlatform>
  readSshConfig?: () => Promise<string | null>
  prewarmRuntime?: (projectId: string) => Promise<unknown>
  prisma?: any
}

type RemoteHostRow = RemoteHostRouteHost & { id: string }

function modelFor(deps: LocalRemoteHostsRouteDependencies): any {
  return (deps.prisma ?? prisma) as any
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

function validPort(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535)
  )
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

function resultExitCode(result: { exitCode?: number | null; code?: number; status?: number }): number | undefined {
  return result.exitCode ?? result.code ?? result.status
}

function commandSucceeded(result: { exitCode?: number | null; code?: number; status?: number }): boolean {
  const code = resultExitCode(result)
  return code === undefined || code === 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Convert the two useful home-directory spellings into shell expressions.
 * Everything else remains one quoted literal, including `$HOME`, globs, and
 * semicolons supplied by a caller.
 */
function remotePathExpression(remotePath: string): string {
  if (remotePath === '~') return '"$HOME"'
  if (remotePath.startsWith('~/')) {
    return `"$HOME/"${quoteRemoteShellArgument(remotePath.slice(2))}`
  }
  return quoteRemoteShellArgument(remotePath)
}

function testRemoteDirectoryCommand(remotePath: string): string {
  const expression = remotePathExpression(remotePath)
  return [
    'set -eu',
    `remote_path=${expression}`,
    'test -d "$remote_path"',
  ].join('\n')
}

function listRemoteDirectoriesCommand(remotePath: string): string {
  const expression = remotePathExpression(remotePath)
  // Shell globs are expanded by the remote shell after the base path has
  // already been safely assigned. The directory test prevents files and
  // unmatched glob literals from entering the response. NUL framing keeps
  // names containing whitespace/newlines unambiguous.
  return [
    'set -eu',
    `base=${expression}`,
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
 * picker. Wildcard/default blocks are intentionally ignored; they often
 * contain policy directives rather than a connectable host.
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
    const match = /^(\S+)\s+(.*?)\s*$/.exec(withoutComment)
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

async function defaultReadSshConfig(): Promise<string | null> {
  try {
    return await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
  } catch {
    return null
  }
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

async function readRemoteHost(
  remoteHostModel: any,
  id: string,
): Promise<RemoteHostRow | null> {
  if (!remoteHostModel?.findUnique) return null
  return remoteHostModel.findUnique({
    where: { id },
    select: REMOTE_HOST_SELECT,
  })
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

export function localRemoteHostsRoutes(
  dependencies: LocalRemoteHostsRouteDependencies = {},
): Hono {
  const router = new Hono()
  const remoteHostModel = modelFor(dependencies).remoteHost
  const localConnections = new Map<string, RemoteHostConnection>()
  const detectPlatform = dependencies.detectPlatform ?? (detectRemotePlatform as any)
  const readConfig = dependencies.readSshConfig ?? defaultReadSshConfig

  const getConnection = (
    host: RemoteHostRow,
  ): RemoteHostConnection => {
    const id = host.id
    const cached = localConnections.get(id)
    if (cached) return cached

    const normalized = normalizeHostForConnection(host)
    const connection =
      dependencies.connectionForHost?.(id, normalized) ??
      dependencies.runtimeManager?.getRemoteConnection?.(id, normalized) ??
      createSSHConnection({
        host: normalized.sshTarget,
        ...(normalized.port == null ? {} : { port: normalized.port }),
        ...(normalized.identityFile ? { identityFile: normalized.identityFile } : {}),
      })
    localConnections.set(id, connection)
    return connection
  }

  const getExistingConnection = async (
    id: string,
  ): Promise<RemoteHostConnection | null> => {
    const cached = localConnections.get(id)
    if (cached) return cached
    const managerConnection = dependencies.runtimeManager?.getExistingRemoteConnection?.(id)
    if (managerConnection) {
      localConnections.set(id, managerConnection)
      return managerConnection
    }
    return null
  }

  const updateConnectionMetadata = async (
    host: RemoteHostRow,
    platform: RemotePlatform,
  ): Promise<RemoteHostRow> => {
    const data = { platform: platform.target, lastConnectedAt: new Date() }
    if (!remoteHostModel?.update) return { ...host, ...data }
    return remoteHostModel.update({
      where: { id: host.id },
      data,
      select: REMOTE_HOST_SELECT,
    })
  }

  const ensureConnected = async (
    host: RemoteHostRow,
    updateMetadata = true,
  ): Promise<{ connection: RemoteHostConnection; platform?: RemotePlatform; connected: boolean }> => {
    const connection = getConnection(host)
    await connection.connect()
    let platform: RemotePlatform | undefined
    // Detecting on every first use also repairs rows created from an SSH
    // config alias whose platform has not yet been saved.
    if (updateMetadata || !host.platform) {
      platform = await detectPlatform(connection)
      if (updateMetadata && platform) await updateConnectionMetadata(host, platform)
    }
    const status = connection.status ? await connection.status() : undefined
    return {
      connection,
      platform,
      connected: status?.connected ?? true,
    }
  }

  router.get('/remote-hosts', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    try {
      const savedRows: RemoteHostRow[] = remoteHostModel?.findMany
        ? await remoteHostModel.findMany({
            orderBy: { label: 'asc' },
            select: REMOTE_HOST_SELECT,
          })
        : []
      const configText = await readConfig()
      const aliases = configText
        ? parseSshConfigAliases(configText).map(aliasHost)
        : []
      return c.json({
        hosts: [
          ...savedRows.map((row) => safeHost(row, { source: 'saved' })),
          ...aliases,
        ],
      })
    } catch (error) {
      console.error('[local-remote-hosts] list failed:', error)
      return c.json({ error: 'remote_host_list_failed' }, 500)
    }
  })

  router.post('/remote-hosts', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    let body: {
      label?: unknown
      sshTarget?: unknown
      port?: unknown
      identityFile?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    if (!isNonEmptyString(body.label, MAX_LABEL_LENGTH) || containsUnsafeControl(body.label)) {
      return c.json({ error: 'invalid_label' }, 400)
    }
    if (
      !isNonEmptyString(body.sshTarget, MAX_SSH_TARGET_LENGTH) ||
      containsUnsafeControl(body.sshTarget) ||
      /\s/.test(body.sshTarget.trim())
    ) {
      return c.json({ error: 'invalid_ssh_target' }, 400)
    }
    if (!validPort(body.port)) return c.json({ error: 'invalid_port' }, 400)
    if (body.identityFile !== undefined) {
      if (
        typeof body.identityFile !== 'string' ||
        !body.identityFile.trim() ||
        body.identityFile.length > MAX_IDENTITY_FILE_LENGTH ||
        containsUnsafeControl(body.identityFile) ||
        /-----BEGIN .*PRIVATE KEY-----/.test(body.identityFile)
      ) {
        return c.json({ error: 'invalid_identity_file' }, 400)
      }
    }
    if (!remoteHostModel?.create) return c.json({ error: 'remote_hosts_unavailable' }, 503)

    try {
      const created = await remoteHostModel.create({
        data: {
          label: body.label.trim(),
          sshTarget: body.sshTarget.trim(),
          ...(body.port === undefined ? {} : { port: body.port }),
          ...(body.identityFile === undefined
            ? {}
            : { identityFile: body.identityFile.trim() }),
        },
        select: REMOTE_HOST_SELECT,
      })
      return c.json({ host: safeHost(created, { source: 'saved' }) }, 201)
    } catch (error: any) {
      console.error('[local-remote-hosts] create failed:', error)
      return c.json({ error: 'remote_host_create_failed', message: errorMessage(error) }, 500)
    }
  })

  router.post('/remote-hosts/:id/connect', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(remoteHostModel, id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)

    try {
      const result = await ensureConnected(host, true)
      const updated = await readRemoteHost(remoteHostModel, id)
      const status = result.connection.status ? await result.connection.status() : undefined
      return c.json({
        host: safeHost(updated ?? host, { source: 'saved' }),
        connected: status?.connected ?? result.connected,
        state: status?.connected === false ? 'disconnected' : (status?.state ?? 'connected'),
        platform: result.platform?.target ?? updated?.platform ?? host.platform ?? null,
      })
    } catch (error) {
      console.warn(`[local-remote-hosts] connect failed for ${id}:`, errorMessage(error))
      return c.json({ error: 'remote_host_connect_failed' }, 503)
    }
  })

  router.get('/remote-hosts/:id/status', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(remoteHostModel, id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)

    let connected = false
    let state = 'disconnected'
    const existing = await getExistingConnection(id)
    if (existing?.status) {
      try {
        const status = await existing.status()
        connected = status.connected
        state = status.connected ? (status.state ?? 'connected') : 'disconnected'
      } catch {
        connected = false
        state = 'disconnected'
      }
    } else if (dependencies.runtimeManager?.getRemoteConnectionStatus) {
      try {
        const status = await dependencies.runtimeManager.getRemoteConnectionStatus(id)
        connected = !!status?.connected
        state = connected ? (status?.state ?? 'connected') : 'disconnected'
      } catch {
        connected = false
        state = 'disconnected'
      }
    }

    let runtime: Array<{ projectId: string; name?: string; status: string; agentPort?: number }> = []
    try {
      const projects = remoteHostModel
        ? await modelFor(dependencies).project.findMany({
            where: { remoteHostId: id },
            select: { id: true, name: true },
          })
        : []
      runtime = (projects ?? []).map((project: { id: string; name?: string }) => {
        const current = dependencies.runtimeManager?.status?.(project.id) as
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
      runtime,
    })
  })

  router.get('/remote-hosts/:id/askpass', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(remoteHostModel, id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)
    const prompt = dependencies.runtimeManager?.getRemoteAskpassPrompt?.(id) ?? null
    return c.json({
      pending: !!prompt,
      ...(prompt ? { prompt: prompt.prompt, createdAt: prompt.createdAt } : {}),
    })
  })

  router.post('/remote-hosts/:id/askpass', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(remoteHostModel, id)
    if (!host) return c.json({ error: 'remote_host_not_found' }, 404)
    if (!dependencies.runtimeManager?.respondRemoteAskpass) {
      return c.json({ error: 'remote_askpass_unavailable' }, 503)
    }
    let body: { answer?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }
    if (
      typeof body.answer !== 'string' ||
      body.answer.length > 8_192 ||
      body.answer.includes('\u0000') ||
      /[\r\n]/.test(body.answer)
    ) {
      return c.json({ error: 'invalid_askpass_response' }, 400)
    }
    try {
      dependencies.runtimeManager.respondRemoteAskpass(id, body.answer)
      return c.json({ accepted: true })
    } catch (error) {
      return c.json({ error: 'remote_askpass_unavailable', message: errorMessage(error) }, 409)
    }
  })

  router.get('/remote-hosts/:id/browse', async (c) => {
    if (!authUserId(c)) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const host = await readRemoteHost(remoteHostModel, id)
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
      return c.json({
        path,
        entries: parseNulSeparatedDirectories(result.stdout),
      })
    } catch (error) {
      console.warn(`[local-remote-hosts] browse failed for ${id}:`, errorMessage(error))
      return c.json({ error: 'remote_browse_failed' }, 503)
    }
  })

  router.post('/projects/from-remote-folder', async (c) => {
    const userId = authUserId(c)
    if (!userId) return c.json({ error: 'unauthenticated' }, 401)

    let body: {
      workspaceId?: unknown
      remoteHostId?: unknown
      path?: unknown
      name?: unknown
      paths?: unknown
      localPath?: unknown
      remotePath?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    // This endpoint has a deliberately separate body shape from the local
    // folder route. Rejecting aliases such as `paths`/`remotePath` prevents
    // callers from accidentally mixing local and remote project semantics.
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
    const host = await readRemoteHost(remoteHostModel, remoteHostId)
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
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : remotePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'New Project'

    let project: any
    try {
      project = await modelFor(dependencies).$transaction(async (tx: any) => {
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
    } catch (error: any) {
      console.error('[local-remote-hosts] project create failed:', error)
      return c.json({ error: 'create_failed', message: errorMessage(error) }, 500)
    }

    const reloaded = modelFor(dependencies).project?.findUnique
      ? await modelFor(dependencies).project.findUnique({
          where: { id: project.id },
          include: { projectFolders: true },
        })
      : project

    const prewarm = dependencies.prewarmRuntime ?? dependencies.runtimeManager?.start
    if (prewarm) {
      void Promise.resolve().then(() => prewarm(project.id)).catch((error) => {
        console.warn(
          `[local-remote-hosts] prewarm failed for ${project.id}:`,
          errorMessage(error),
        )
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
