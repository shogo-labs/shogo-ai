// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState } from 'react'
import { useDomainHttp, useProjectCollection } from '../../contexts/domain'
import { api } from '../../lib/api'
import {
  publishWorkspaceSessionScopeChanged,
  subscribeWorkspaceSessionScopeChanged,
} from './workspace-agent-session-bus'

export type WorkspaceSessionAttachment = {
  id: string
  projectId: string
  attachMode: 'readwrite' | 'readonly'
}

export function useWorkspaceSessionScope(workspaceId: string | null | undefined, sessionId: string | null | undefined) {
  const http = useDomainHttp()
  const projects = useProjectCollection()
  const [attachments, setAttachments] = useState<WorkspaceSessionAttachment[]>([])
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null)
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !sessionId) {
      setAttachments([])
      setFocusedProjectId(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const next = await api.getWorkspaceSessionProjects(http, workspaceId, sessionId)
        if (!cancelled) setAttachments(next)
      } catch {
        if (!cancelled) setAttachments([])
      }
    }
    void load()
    void projects.loadAll({ workspaceId }).catch(() => undefined)
    const unsubscribe = subscribeWorkspaceSessionScopeChanged(workspaceId, (changedSessionId) => {
      if (changedSessionId === sessionId) void load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [http, projects, sessionId, workspaceId])

  useEffect(() => {
    if (focusedProjectId && attachments.some((attachment) => attachment.projectId === focusedProjectId)) return
    setFocusedProjectId(attachments[0]?.projectId ?? null)
  }, [attachments, focusedProjectId])

  const projectName = (projectId: string) =>
    projects.all.find((project: any) => project.id === projectId)?.name ?? `Project ${projectId.slice(0, 8)}`

  const attachableProjects = useMemo(
    () => projects.all.filter(
      (project: any) => project.workspaceId === workspaceId
        && !attachments.some((attachment) => attachment.projectId === project.id),
    ),
    [attachments, projects.all, workspaceId],
  )

  const attachProject = async (projectId: string) => {
    if (!workspaceId || !sessionId || busyProjectId) return
    const optimisticId = `pending-${projectId}`
    try {
      setBusyProjectId(projectId)
      setError(null)
      setAttachments((current) => [...current, { id: optimisticId, projectId, attachMode: 'readwrite' }])
      const attached = await api.attachProject(http, workspaceId, sessionId, projectId, 'readwrite')
      setAttachments((current) => [
        ...current.filter((attachment) => attachment.id !== optimisticId),
        { id: attached.id, projectId: attached.projectId, attachMode: attached.attachMode as 'readwrite' | 'readonly' },
      ])
      setFocusedProjectId(projectId)
      publishWorkspaceSessionScopeChanged(workspaceId, sessionId)
    } catch {
      setAttachments((current) => current.filter((attachment) => attachment.id !== optimisticId))
      setError('Could not attach this project. Check access and try again.')
    } finally {
      setBusyProjectId(null)
    }
  }

  const detachProject = async (attachment: WorkspaceSessionAttachment) => {
    if (!workspaceId || !sessionId || busyProjectId) return
    try {
      setBusyProjectId(attachment.projectId)
      setError(null)
      setAttachments((current) => current.filter((item) => item.id !== attachment.id))
      await api.detachWorkspaceSessionProject(http, workspaceId, sessionId, attachment.projectId)
      publishWorkspaceSessionScopeChanged(workspaceId, sessionId)
    } catch {
      setAttachments((current) => current.some((item) => item.id === attachment.id) ? current : [...current, attachment])
      setError('Could not detach this project. It remains in the working set.')
    } finally {
      setBusyProjectId(null)
    }
  }

  const toggleProjectMode = async (attachment: WorkspaceSessionAttachment) => {
    if (!workspaceId || !sessionId || busyProjectId) return
    const nextMode = attachment.attachMode === 'readonly' ? 'readwrite' : 'readonly'
    try {
      setBusyProjectId(attachment.projectId)
      setError(null)
      setAttachments((current) => current.map((item) => item.id === attachment.id ? { ...item, attachMode: nextMode } : item))
      const updated = await api.attachProject(http, workspaceId, sessionId, attachment.projectId, nextMode)
      setAttachments((current) => current.map((item) => item.id === attachment.id
        ? { ...item, attachMode: updated.attachMode as 'readwrite' | 'readonly' }
        : item))
      publishWorkspaceSessionScopeChanged(workspaceId, sessionId)
    } catch {
      setAttachments((current) => current.map((item) => item.id === attachment.id
        ? { ...item, attachMode: attachment.attachMode }
        : item))
      setError('Could not update project access. Your previous scope was restored.')
    } finally {
      setBusyProjectId(null)
    }
  }

  return {
    attachments,
    focusedProjectId,
    setFocusedProjectId,
    busyProjectId,
    error,
    projectName,
    attachableProjects,
    attachProject,
    detachProject,
    toggleProjectMode,
  }
}
