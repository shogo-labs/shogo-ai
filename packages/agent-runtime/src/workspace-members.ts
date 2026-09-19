// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Live membership registry for workspace (merged-root) runtimes.
 *
 * The boot-time WORKSPACE_PROJECT_IDS/LINKED_FOLDERS env is still used to
 * construct the initial runtime, but Slack's meta-agent can add and remove
 * members without killing the process.  This module owns the small mutable
 * layer: the visible catalog, allowed roots, and WORKSPACE.md.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  isWorkspaceRuntimeMode,
  workspaceAttachedProjectIds,
  workspaceAvailableProjectsManifest,
  workspaceProjectsManifest,
  type WorkspaceProjectEntry,
} from './workspace-runtime-mode'
import { updateWorkspaceFolders } from './trust-resolver'
import { createS3SyncForProject, type S3Sync } from '@shogo/shared-runtime'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export interface WorkspaceMember extends WorkspaceProjectEntry {
  mounted: true
  mountPath: string
  realPath?: string
  readonly: boolean
}

export interface MountWorkspaceMemberInput {
  id: string
  name?: string | null
  description?: string | null
  /** Existing host project directory. The API supplies this for local mode. */
  realPath?: string
  /** A project can be mounted read-only for cross-project inspection. */
  readonly?: boolean
}

interface RegistryState {
  workspaceDir: string
  workspaceId: string
  available: WorkspaceProjectEntry[]
  members: Map<string, WorkspaceMember>
  syncs: Map<string, S3Sync>
  initialized: boolean
}

const state: RegistryState = {
  workspaceDir: process.env.WORKSPACE_DIR || process.env.AGENT_DIR || '/app/workspace',
  workspaceId: process.env.WORKSPACE_ID || '',
  available: [],
  members: new Map(),
  syncs: new Map(),
  initialized: false,
}

let mutation: Promise<void> = Promise.resolve()

function safeId(id: string): boolean {
  return typeof id === 'string' && SAFE_ID.test(id)
}

function queueMutation<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutation.then(fn, fn)
  mutation = next.then(() => undefined, () => undefined)
  return next
}

function memberPath(id: string): string {
  return join(state.workspaceDir, id)
}

function realPathForMount(id: string, supplied?: string): string | undefined {
  if (supplied) return resolve(supplied)
  const path = memberPath(id)
  try {
    if (lstatSync(path).isSymbolicLink()) return resolve(state.workspaceDir, readlinkSync(path))
  } catch {
    // The path may be a cloud directory or may not exist yet.
  }
  return existsSync(path) ? path : undefined
}

function writeManifest(): void {
  if (!state.initialized || !isWorkspaceRuntimeMode()) return
  try {
    const mounted = [...state.members.values()]
    const mountedIds = new Set(mounted.map((m) => m.id))
    const available = state.available.filter((p) => !mountedIds.has(p.id))
    const lines = [
      '# Workspace',
      '',
      `This is a multi-project workspace runtime (workspace \`${state.workspaceId}\`).`,
      'You are a meta-agent. Keep the runtime empty until a request requires',
      'project files or commands, then use `mount_project` for the smallest',
      'relevant project. Use `unmount_project` when a project is no longer',
      'needed. Mounted projects are sibling folders under this directory.',
      '',
      '## Mounted projects',
      '',
    ]
    if (mounted.length === 0) lines.push('_No projects are mounted._')
    for (const project of mounted) {
      lines.push(
        `- \`${project.id}/\` — **${project.name}**${project.readonly ? ' (read-only)' : ''}` +
          (project.description ? ` — ${project.description}` : ''),
      )
    }
    lines.push('', '## Available projects', '')
    if (available.length === 0) lines.push('_No additional projects are available._')
    for (const project of available) {
      lines.push(
        `- \`${project.id}\` — **${project.name}**` +
          (project.description ? ` — ${project.description}` : ''),
      )
    }
    lines.push(
      '',
      'Answer workspace/catalog questions without mounting. Mount before reading, editing, testing, or running commands in a project.',
      'Tell the user which project you mounted when doing project work. Never guess between similarly plausible projects: inspect the catalog and ask one concise clarification when the request does not identify a project clearly.',
      '',
    )
    mkdirSync(state.workspaceDir, { recursive: true })
    writeFileSync(join(state.workspaceDir, 'WORKSPACE.md'), lines.join('\n'))
    const shogoDir = join(state.workspaceDir, '.shogo')
    mkdirSync(shogoDir, { recursive: true })
    writeFileSync(
      join(shogoDir, 'workspace.json'),
      JSON.stringify(
        { workspaceId: state.workspaceId, mounted, available },
        null,
        2,
      ),
    )
  } catch (error: any) {
    console.warn(`[agent-runtime] Could not refresh workspace manifest: ${error?.message ?? error}`)
  }
}

export function initWorkspaceMembers(): void {
  if (!isWorkspaceRuntimeMode()) return
  state.workspaceDir = process.env.WORKSPACE_DIR || process.env.AGENT_DIR || '/app/workspace'
  state.workspaceId = process.env.WORKSPACE_ID || ''
  state.available = workspaceAvailableProjectsManifest()
  if (state.available.length === 0) state.available = workspaceProjectsManifest()
  state.members.clear()
  state.syncs.clear()

  const names = new Map(workspaceProjectsManifest().map((p) => [p.id, p]))
  for (const id of workspaceAttachedProjectIds()) {
    const fromCatalog = names.get(id) ?? state.available.find((p) => p.id === id)
    const root = memberPath(id)
    state.members.set(id, {
      id,
      name: fromCatalog?.name ?? id,
      description: fromCatalog?.description ?? null,
      mounted: true,
      mountPath: root,
      realPath: realPathForMount(id),
      readonly: false,
    })
  }
  state.initialized = true
  writeManifest()
}

export function isWorkspaceMembersInitialized(): boolean {
  return state.initialized
}

export function listWorkspaceMembers(): WorkspaceMember[] {
  return [...state.members.values()].map((member) => ({ ...member }))
}

export function listAvailableWorkspaceProjects(): WorkspaceProjectEntry[] {
  return state.available.map((project) => ({ ...project }))
}

export async function mountWorkspaceMember(input: MountWorkspaceMemberInput): Promise<WorkspaceMember> {
  return queueMutation(async () => {
    if (!state.initialized) initWorkspaceMembers()
    if (!safeId(input.id)) throw new Error('Invalid workspace project id')
    const existing = state.members.get(input.id)
    if (existing) {
      if (input.readonly !== undefined && existing.readonly !== input.readonly) {
        const root = existing.realPath || existing.mountPath
        existing.readonly = input.readonly
        updateWorkspaceFolders({
          readonlyRemove: input.readonly ? [] : [root],
          readonlyAdd: input.readonly ? [root] : [],
        })
        writeManifest()
      }
      return { ...existing }
    }
    const mountPath = memberPath(input.id)
    const realPath = realPathForMount(input.id, input.realPath)

    if (realPath && resolve(realPath) !== resolve(mountPath) && !existsSync(mountPath)) {
      mkdirSync(state.workspaceDir, { recursive: true })
      symlinkSync(realPath, mountPath, 'dir')
    } else if (!existsSync(mountPath)) {
      mkdirSync(mountPath, { recursive: true })
    }

    // Cloud workspace runtimes have real subdirectories rather than host
    // symlinks. Hydrate a newly-added member from its layered archive before
    // exposing it to the agent; the source layer is intentionally small and
    // dependency restoration remains in the background.
    if (!realPath && (process.env.S3_WORKSPACES_BUCKET || process.env.S3_BUCKET)) {
      const sync = createS3SyncForProject(mountPath, input.id, {
        watchEnabled: true,
        syncInterval: Number(process.env.S3_SYNC_INTERVAL || 30_000),
      } as any)
      if (sync) {
        await sync.downloadAll()
        sync.startPeriodicSync()
        sync.startWatcher()
        state.syncs.set(input.id, sync)
      }
    }

    const known = state.available.find((p) => p.id === input.id)
    const member: WorkspaceMember = {
      id: input.id,
      name: input.name || known?.name || input.id,
      description: input.description ?? known?.description ?? null,
      mounted: true,
      mountPath,
      realPath: realPathForMount(input.id, realPath),
      readonly: input.readonly === true,
    }
    state.members.set(input.id, member)
    const allowedRoot = member.realPath || member.mountPath
    updateWorkspaceFolders({
      add: [allowedRoot],
      readonlyAdd: member.readonly ? [allowedRoot] : [],
    })
    process.env.WORKSPACE_PROJECT_IDS = [...state.members.keys()].join(',')
    writeManifest()
    return { ...member }
  })
}


export async function unmountWorkspaceMember(projectId: string): Promise<boolean> {
  return queueMutation(async () => {
    const member = state.members.get(projectId)
    if (!member) return false
    state.members.delete(projectId)
    const sync = state.syncs.get(projectId)
    if (sync) {
      try { await (sync as any).flushAndShutdown?.({ timeoutMs: 10_000, forceProjectArchive: true }) } catch {}
      try { (sync as any).stopPeriodicSync?.() } catch {}
      try { (sync as any).stopWatcher?.() } catch {}
      state.syncs.delete(projectId)
    }
    const root = member.realPath || member.mountPath
    updateWorkspaceFolders({
      remove: [root, member.mountPath],
      readonlyRemove: [root, member.mountPath],
    })
    // Only remove a symlink or an empty cloud mount created by this registry.
    // Never recursively delete a real project directory.
    try {
      if (lstatSync(member.mountPath).isSymbolicLink()) unlinkSync(member.mountPath)
      else if (existsSync(member.mountPath)) rmSync(member.mountPath, { recursive: true, force: true })
    } catch {
      // A concurrent API/runtime refresh may already have removed it.
    }
    process.env.WORKSPACE_PROJECT_IDS = [...state.members.keys()].join(',')
    writeManifest()
    return true
  })
}
