// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared read/write path for a project's exposed ports. The public Studio
 * routes and the agent-runtime's internal routes both go through here so
 * the allowlist, the visibility rules, and the live push to the guest stay
 * in one place.
 */

import { prisma } from './prisma'
import { encodeProjectSettingsForWrite, parseProjectSettings } from './project-settings'
import {
  addProjectPort,
  isDeclaredPort,
  removeProjectPort,
  resolveExposedPorts,
  withPortVisibility,
  type ExposedPort,
  type PortProtocol,
  type PortVisibility,
} from './project-ports'

export interface PortMutationResult {
  ok: true
  ports: ExposedPort[]
  techStackId: string | undefined
  workspaceId: string | null
}

export interface PortMutationError {
  ok: false
  status: number
  message: string
}

async function load(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { settings: true, workspaceId: true },
  })
  if (!project) return null
  const settings = parseProjectSettings(project.settings) ?? {}
  const techStackId = settings.techStackId as string | undefined
  return { settings, techStackId, workspaceId: project.workspaceId }
}

async function save(
  projectId: string,
  settings: Record<string, unknown>,
  exposedPorts: Record<string, unknown>,
): Promise<void> {
  const nextSettings = { ...settings, exposedPorts }
  await prisma.project.update({
    where: { id: projectId },
    data: { settings: encodeProjectSettingsForWrite(nextSettings) as any },
  })
  const techStackId = nextSettings.techStackId as string | undefined
  const ports = resolveExposedPorts(techStackId, nextSettings).map((p) => p.port)
  await pushExposedPorts(projectId, ports)
}

export async function readProjectPorts(projectId: string): Promise<ExposedPort[] | null> {
  const row = await load(projectId)
  if (!row) return null
  return resolveExposedPorts(row.techStackId, row.settings)
}

export async function setProjectPortVisibility(
  projectId: string,
  port: number,
  visibility: PortVisibility,
): Promise<PortMutationResult | PortMutationError> {
  const row = await load(projectId)
  if (!row) return { ok: false, status: 404, message: 'Project not found' }
  const current = resolveExposedPorts(row.techStackId, row.settings).find((p) => p.port === port)
  if (!current) return { ok: false, status: 404, message: 'Port is not exposed by this project' }
  if (visibility === 'preview' && current.protocol !== 'http') {
    return { ok: false, status: 400, message: 'Only http ports can be made publicly previewable' }
  }
  const exposedPorts = withPortVisibility(row.settings, port, visibility)
  await save(projectId, row.settings, exposedPorts)
  return {
    ok: true,
    ports: resolveExposedPorts(row.techStackId, { ...row.settings, exposedPorts }),
    techStackId: row.techStackId,
    workspaceId: row.workspaceId,
  }
}

export async function createProjectPort(
  projectId: string,
  input: { port: number; protocol: PortProtocol; label?: string },
): Promise<PortMutationResult | PortMutationError> {
  const row = await load(projectId)
  if (!row) return { ok: false, status: 404, message: 'Project not found' }
  const added = addProjectPort(row.techStackId, row.settings, input)
  if (!added.ok) return { ok: false, status: 400, message: added.error }
  await save(projectId, row.settings, added.exposedPorts)
  return {
    ok: true,
    ports: resolveExposedPorts(row.techStackId, { ...row.settings, exposedPorts: added.exposedPorts }),
    techStackId: row.techStackId,
    workspaceId: row.workspaceId,
  }
}

export async function deleteProjectPort(
  projectId: string,
  port: number,
): Promise<PortMutationResult | PortMutationError> {
  const row = await load(projectId)
  if (!row) return { ok: false, status: 404, message: 'Project not found' }
  if (isDeclaredPort(row.techStackId, port)) {
    return { ok: false, status: 400, message: 'Stack default ports cannot be removed' }
  }
  const removed = removeProjectPort(row.techStackId, row.settings, port)
  if (!removed.ok) return { ok: false, status: 404, message: removed.error }
  await save(projectId, row.settings, removed.exposedPorts)
  return {
    ok: true,
    ports: resolveExposedPorts(row.techStackId, { ...row.settings, exposedPorts: removed.exposedPorts }),
    techStackId: row.techStackId,
    workspaceId: row.workspaceId,
  }
}

/**
 * Tell a running runtime its new allowlist. A sleeping runtime is fine:
 * the next assign rebuilds `SHOGO_EXPOSED_PORTS` from the same settings.
 */
export async function pushExposedPorts(projectId: string, ports: number[]): Promise<void> {
  try {
    const { resolveProjectPodUrl } = await import('./resolve-pod-url')
    const { deriveProjectRuntimeToken } = await import('./project-runtime-token')
    const resolved = await resolveProjectPodUrl(projectId, {
      logTag: 'ports/allowlist',
      metalWaitMs: 1500,
      metalRetryDelayMs: 400,
    })
    const token = await deriveProjectRuntimeToken(projectId)
    await fetch(`${resolved.url.replace(/\/+$/, '')}/agent/ports/allowlist`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-runtime-token': token },
      body: JSON.stringify({ ports }),
      signal: AbortSignal.timeout(3000),
    })
  } catch (err: any) {
    console.warn(`[ports] allowlist push for ${projectId} skipped:`, err?.message ?? err)
  }
}
