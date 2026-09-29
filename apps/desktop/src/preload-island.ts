// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { contextBridge, ipcRenderer } from 'electron'
import {
  ISLAND_MAX_FILES,
  validateIslandFiles,
  type IslandAttachment,
} from './island-attachments'

type IslandMode = 'hidden' | 'collapsed' | 'expanded' | 'compose'
type IslandStatus = 'idle' | 'running' | 'done' | 'needs_approval' | 'needs_answer'

interface IslandPermission {
  id: string
  toolName: string
  reason: string
  params: Record<string, unknown>
  timeout: number
}

interface IslandPending {
  kind: 'permission' | 'question'
  request: {
    id: string
    toolName?: string
    reason?: string
    params?: Record<string, unknown>
    timeout?: number
    prompt?: string
    options?: Array<{ label: string; description?: string }>
  }
}

interface IslandSession {
  sessionId: string
  projectId: string
  projectName: string
  title: string
  status: IslandStatus
  step?: string
  replyPreview?: string
  pending?: IslandPending
}

interface IslandSnapshot {
  sessions: IslandSession[]
  recentProjects: Array<{ projectId: string; name: string }>
  updatedAt: number
}

type IslandAction =
  | { type: 'open'; projectId: string; sessionId: string }
  | { type: 'permission'; requestId: string; decision: 'allow_once' | 'always_allow' | 'deny'; pattern?: string }
  | { type: 'question'; requestId: string; response: string }
  | {
      type: 'send'
      target:
        | { kind: 'session'; projectId: string; sessionId: string }
        | { kind: 'new'; projectId: string }
      text: string
      files?: IslandAttachment[]
    }

type IslandTarget =
  | { kind: 'session'; projectId: string; sessionId: string }
  | { kind: 'new'; projectId: string }

let snapshot: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 0 }
let mode: IslandMode = 'collapsed'
let composeTarget: IslandTarget | null = null
let composeFiles: IslandAttachment[] = []
let composeError = ''
let composeText = ''
const pendingStartedAt = new Map<string, number>()

function sendAction(action: IslandAction): void {
  ipcRenderer.send('island:action', action)
}

function setMode(nextMode: IslandMode): void {
  mode = nextMode
  ipcRenderer.send('island:mode', nextMode)
  render()
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function summarizeParams(params: Record<string, unknown> | undefined): string {
  if (!params) return ''
  const values = Object.entries(params)
    .filter(([key]) => !['timeout', 'category'].includes(key))
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return values.join(' · ').slice(0, 260)
}

function permissionPattern(params: Record<string, unknown> | undefined): string {
  if (!params) return ''
  for (const key of ['command', 'path', 'url', 'name']) {
    if (typeof params[key] === 'string') return params[key] as string
  }
  return ''
}

function currentTarget(): IslandTarget {
  if (composeTarget) return composeTarget
  const firstSession = snapshot.sessions[0]
  if (firstSession) {
    return {
      kind: 'session',
      projectId: firstSession.projectId,
      sessionId: firstSession.sessionId,
    }
  }
  const firstProject = snapshot.recentProjects[0]
  return { kind: 'new', projectId: firstProject?.projectId ?? '' }
}

function render(): void {
  const root = document.getElementById('island-root')
  if (!root) return

  if (mode === 'hidden') {
    root.innerHTML = '<button class="hot-zone" aria-label="Show Shogo island"></button>'
    return
  }

  if (mode === 'collapsed') {
    const attention = snapshot.sessions.some(
      (session) => session.status === 'needs_approval' || session.status === 'needs_answer',
    )
    root.innerHTML = `
      <button class="collapsed" aria-label="Open Shogo island">
        <span class="brand-dot ${attention ? 'attention' : ''}"></span>
        <span>${snapshot.sessions.length ? `${snapshot.sessions.length} active` : 'Shogo'}</span>
        <span class="chevron">⌄</span>
      </button>
    `
    return
  }

  if (mode === 'compose') {
    renderCompose(root)
    return
  }

  const rows = snapshot.sessions.length
    ? snapshot.sessions
        .map(
          (session) => `
            <div class="session-row">
              <button class="session-main" data-open-project="${escapeHtml(session.projectId)}" data-open-session="${escapeHtml(session.sessionId)}">
                <span class="status-dot ${escapeHtml(session.status)}"></span>
                <span class="session-copy">
                  <strong>${escapeHtml(session.title)}</strong>
                  <small>${escapeHtml(session.step || session.status.replaceAll('_', ' '))}</small>
                </span>
              </button>
              <button class="reply-button" data-reply-project="${escapeHtml(session.projectId)}" data-reply-session="${escapeHtml(session.sessionId)}" aria-label="Reply in chat">↩</button>
            </div>
            ${session.replyPreview ? `<p class="preview">${escapeHtml(session.replyPreview)}</p>` : ''}
          `,
        )
        .join('')
    : '<p class="empty">No open chat sessions</p>'

  const pending = snapshot.sessions.find((session) => session.pending)?.pending
  const pendingMarkup = pending ? renderPending(pending) : ''
  root.innerHTML = `
    <section class="island-card">
      <header class="island-header">
        <span class="island-title"><span class="brand-dot"></span> Shogo</span>
        <button class="header-button" data-compose="true" aria-label="Quick chat">＋</button>
        <button class="header-button" data-collapse="true" aria-label="Collapse">⌃</button>
      </header>
      <div class="sessions">${rows}</div>
      ${pendingMarkup}
    </section>
  `
}

function renderPending(pending: IslandPending): string {
  if (pending.kind === 'permission') {
    const request = pending.request
    const started = pendingStartedAt.get(request.id) ?? Date.now()
    pendingStartedAt.set(request.id, started)
    const timeout = Math.max(
      0,
      (request.timeout ?? 30) - Math.floor((Date.now() - started) / 1000),
    )
    return `
      <section class="pending-card permission-card">
        <div class="pending-label">Permission needed · ${timeout}s</div>
        <strong>${escapeHtml(request.toolName || 'Tool request')}</strong>
        <p>${escapeHtml(request.reason || summarizeParams(request.params))}</p>
        <div class="actions">
          <button class="deny" data-permission="deny" data-request-id="${escapeHtml(request.id)}">Deny</button>
          <button data-permission="allow_once" data-request-id="${escapeHtml(request.id)}">Allow once</button>
          <button class="primary" data-permission="always_allow" data-pattern="${escapeHtml(permissionPattern(request.params))}" data-request-id="${escapeHtml(request.id)}">Always</button>
        </div>
      </section>
    `
  }

  return `
    <section class="pending-card question-card">
      <div class="pending-label">Shogo needs an answer</div>
      <strong>${escapeHtml(pending.request.prompt || 'Choose an option')}</strong>
      <div class="question-options">
        ${(pending.request.options ?? [])
          .map(
            (option) =>
              `<button data-question="${escapeHtml(option.label)}" data-request-id="${escapeHtml(pending.request.id)}">${escapeHtml(option.label)}</button>`,
          )
          .join('')}
      </div>
    </section>
  `
}

function renderCompose(root: HTMLElement): void {
  const target = currentTarget()
  const targetLabel =
    target.kind === 'session'
      ? snapshot.sessions.find((session) => session.sessionId === target.sessionId)?.title ?? 'Active chat'
      : snapshot.recentProjects.find((project) => project.projectId === target.projectId)?.name ?? 'New chat'
  const targetOptions = [
    ...snapshot.sessions.map(
      (session) =>
        `<option value="session:${escapeHtml(session.projectId)}:${escapeHtml(session.sessionId)}" ${
          target.kind === 'session' && target.sessionId === session.sessionId ? 'selected' : ''
        }>Reply in: ${escapeHtml(session.title)}</option>`,
    ),
    ...snapshot.recentProjects.map(
      (project) =>
        `<option value="new:${escapeHtml(project.projectId)}" ${
          target.kind === 'new' && target.projectId === project.projectId ? 'selected' : ''
        }>New chat in: ${escapeHtml(project.name)}</option>`,
    ),
  ].join('')

  root.innerHTML = `
    <section class="island-card compose-card">
      <header class="island-header">
        <span class="island-title">Quick chat</span>
        <button class="header-button" data-collapse="true" aria-label="Close">×</button>
      </header>
      <select id="compose-target" aria-label="Chat target">${targetOptions || `<option value="new:${escapeHtml(target.projectId)}">${escapeHtml(targetLabel)}</option>`}</select>
      <div class="drop-area" id="drop-area">
        ${composeFiles.length ? composeFiles.map((file) => `<span class="file-chip">${escapeHtml(file.name)}</span>`).join('') : 'Drop files here or use Attach'}
      </div>
      ${composeError ? `<p class="compose-error">${escapeHtml(composeError)}</p>` : ''}
      <textarea id="compose-input" rows="2" placeholder="Ask Shogo anything…">${escapeHtml(composeText)}</textarea>
      <div class="compose-footer">
        <label class="attach-button">Attach<input id="file-input" type="file" multiple /></label>
        <button class="primary send-button" data-send="true" ${
          composeText.trim() || composeFiles.length ? '' : 'disabled'
        }>Send</button>
      </div>
    </section>
  `
  const input = document.getElementById('compose-input') as HTMLTextAreaElement | null
  input?.focus()
  input?.setSelectionRange(input.value.length, input.value.length)
}

async function readFiles(files: readonly File[]): Promise<void> {
  const room = ISLAND_MAX_FILES - composeFiles.length
  if (room <= 0) {
    composeError = `Maximum ${ISLAND_MAX_FILES} files allowed`
    render()
    return
  }
  const selected = files.slice(0, room)
  const error = validateIslandFiles(selected)
  if (error) {
    composeError = error
    render()
    return
  }
  try {
    const attachments = await Promise.all(
      selected.map(
        (file) =>
          new Promise<IslandAttachment>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () =>
              typeof reader.result === 'string'
                ? resolve({ dataUrl: reader.result, name: file.name, type: file.type })
                : reject(new Error(`Could not read "${file.name}"`))
            reader.onerror = () => reject(new Error(`Could not read "${file.name}"`))
            reader.readAsDataURL(file)
          }),
      ),
    )
    composeFiles = [...composeFiles, ...attachments]
    composeError = files.length > room ? `Maximum ${ISLAND_MAX_FILES} files allowed` : ''
  } catch (error) {
    composeError = error instanceof Error ? error.message : 'Could not read attachment'
  }
  render()
}

function parseTarget(value: string): IslandTarget {
  if (value.startsWith('session:')) {
    const [, projectId, sessionId] = value.split(':')
    return { kind: 'session', projectId, sessionId }
  }
  return { kind: 'new', projectId: value.slice('new:'.length) }
}

function sendCompose(): void {
  const input = document.getElementById('compose-input') as HTMLTextAreaElement | null
  const targetInput = document.getElementById('compose-target') as HTMLSelectElement | null
  const text = input?.value ?? composeText
  const target = targetInput ? parseTarget(targetInput.value) : currentTarget()
  if (!text.trim() && composeFiles.length === 0) return
  composeText = ''
  sendAction({ type: 'send', target, text, files: composeFiles.length ? composeFiles : undefined })
  composeFiles = []
  composeError = ''
  render()
}

function containsDirectory(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.items ?? []).some((item) => {
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory?: boolean } | null
    }).webkitGetAsEntry?.()
    return entry?.isDirectory === true
  })
}

function installDomHandlers(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.hot-zone')) {
      setMode('expanded')
      return
    }
    const openButton = target.closest<HTMLElement>('[data-open-project]')
    if (openButton) {
      sendAction({
        type: 'open',
        projectId: openButton.dataset.openProject || '',
        sessionId: openButton.dataset.openSession || '',
      })
      setMode('collapsed')
      return
    }
    const replyButton = target.closest<HTMLElement>('[data-reply-project]')
    if (replyButton) {
      composeTarget = {
        kind: 'session',
        projectId: replyButton.dataset.replyProject || '',
        sessionId: replyButton.dataset.replySession || '',
      }
      setMode('compose')
      return
    }
    if (target.closest('[data-compose]')) {
      composeTarget = null
      setMode('compose')
      return
    }
    if (target.closest('[data-collapse]') || target.closest('.collapsed')) {
      setMode(mode === 'collapsed' ? 'expanded' : 'collapsed')
      return
    }
    const permissionButton = target.closest<HTMLElement>('[data-permission]')
    if (permissionButton) {
      sendAction({
        type: 'permission',
        requestId: permissionButton.dataset.requestId || '',
        decision: permissionButton.dataset.permission as 'allow_once' | 'always_allow' | 'deny',
        ...(permissionButton.dataset.pattern
          ? { pattern: permissionButton.dataset.pattern }
          : {}),
      })
      return
    }
    const questionButton = target.closest<HTMLElement>('[data-question]')
    if (questionButton) {
      sendAction({
        type: 'question',
        requestId: questionButton.dataset.requestId || '',
        response: questionButton.dataset.question || '',
      })
      return
    }
    if (target.closest('[data-send]')) sendCompose()
  })

  document.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.collapsed') || target.closest('.hot-zone')) {
      if (mode !== 'expanded' && mode !== 'compose') setMode('expanded')
    }
  })

  document.addEventListener('input', (event) => {
    const target = event.target as HTMLTextAreaElement
    if (target.id === 'compose-input') composeText = target.value
  })

  document.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement
    if (target.id === 'compose-target') {
      composeTarget = parseTarget((target as HTMLSelectElement).value)
      return
    }
    const fileInput = target as HTMLInputElement
    if (target.id === 'file-input' && fileInput.files) {
      void readFiles(Array.from(fileInput.files))
      fileInput.value = ''
    }
  })

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    if (target.id === 'compose-input' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendCompose()
    }
    if (event.key === 'Escape') setMode('collapsed')
  })

  document.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (mode !== 'compose') setMode('expanded')
    document.body.classList.add('drag-over')
  })
  document.addEventListener('dragleave', () => document.body.classList.remove('drag-over'))
  document.addEventListener('drop', (event) => {
    event.preventDefault()
    document.body.classList.remove('drag-over')
    if (containsDirectory(event.dataTransfer)) {
      composeError = 'Folders cannot be attached here'
      setMode('compose')
      render()
      return
    }
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length) {
      if (mode !== 'compose') setMode('compose')
      void readFiles(files)
    }
  })

  let collapseTimer: ReturnType<typeof setTimeout> | null = null
  document.addEventListener('mouseenter', () => {
    if (collapseTimer) clearTimeout(collapseTimer)
    collapseTimer = null
  })
  document.addEventListener('mouseleave', () => {
    if (mode !== 'expanded') return
    collapseTimer = setTimeout(() => {
      collapseTimer = null
      if (!snapshot.sessions.some((session) => session.pending)) setMode('collapsed')
    }, 700)
  })

  setInterval(() => {
    if (mode === 'expanded' && snapshot.sessions.some((session) => session.pending)) render()
  }, 1000)
}

contextBridge.exposeInMainWorld('shogoIsland', {
  onSnapshot: (callback: (value: IslandSnapshot) => void) => {
    ipcRenderer.on('island:snapshot', (_event, value: IslandSnapshot) => {
      snapshot = value
      callback(value)
      render()
    })
  },
  sendAction,
  setMode,
  setInteractive: (interactive: boolean) => ipcRenderer.send('island:interactive', interactive),
  onMode: (callback: (value: IslandMode) => void) => {
    ipcRenderer.on('island:mode', (_event, value: IslandMode) => {
      mode = value
      callback(value)
      render()
    })
  },
  onOpenCompose: (callback: () => void) => {
    ipcRenderer.on('island:open-compose', () => callback())
  },
})

ipcRenderer.on('island:snapshot', (_event, value: IslandSnapshot) => {
  snapshot = value
  render()
})
ipcRenderer.on('island:mode', (_event, value: IslandMode) => {
  mode = value
  render()
})
ipcRenderer.on('island:open-compose', () => {
  composeTarget = null
  mode = 'compose'
  render()
})

window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style')
  style.textContent = `
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: transparent; color: #f5f5f7; overflow: hidden; }
    body { min-width: 100%; min-height: 100%; }
    button, select, textarea { font: inherit; }
    button { color: inherit; border: 0; cursor: pointer; }
    #island-root { width: 100%; min-height: 100%; }
    .hot-zone { display: block; width: 100%; height: 100%; background: transparent; }
    .collapsed, .island-card { background: rgba(22, 22, 24, .96); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 10px 35px rgba(0,0,0,.35); }
    .collapsed { width: 100%; min-height: 32px; border-radius: 18px; display: flex; align-items: center; justify-content: center; gap: 7px; padding: 5px 14px; font-size: 12px; }
    .island-card { border-radius: 18px; padding: 10px; max-height: 560px; overflow: auto; }
    .island-header, .compose-footer { display: flex; align-items: center; gap: 6px; }
    .island-header { min-height: 24px; margin-bottom: 8px; }
    .island-title { flex: 1; font-size: 12px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
    .header-button { background: transparent; color: #aaa; font-size: 17px; padding: 0 4px; }
    .brand-dot, .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: #8e8e93; flex: 0 0 auto; }
    .brand-dot { background: #8b5cf6; } .brand-dot.attention { background: #ff9f0a; box-shadow: 0 0 0 3px rgba(255,159,10,.18); }
    .status-dot.running { background: #30d158; box-shadow: 0 0 0 3px rgba(48,209,88,.14); }
    .status-dot.done { background: #64d2ff; } .status-dot.needs_approval, .status-dot.needs_answer { background: #ff9f0a; }
    .session-row { display: flex; gap: 4px; align-items: center; padding: 6px 0; }
    .session-main { display: flex; gap: 8px; align-items: center; flex: 1; text-align: left; background: transparent; padding: 2px; min-width: 0; }
    .session-copy { display: flex; flex-direction: column; min-width: 0; } .session-copy strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-copy small { color: #999; font-size: 10px; margin-top: 2px; }
    .reply-button { background: rgba(255,255,255,.08); width: 24px; height: 24px; border-radius: 12px; color: #ccc; }
    .preview { color: #a5a5aa; font-size: 10px; margin: -2px 28px 3px 20px; max-height: 28px; overflow: hidden; }
    .pending-card { border-radius: 12px; margin-top: 8px; padding: 9px; background: rgba(255,159,10,.11); border: 1px solid rgba(255,159,10,.28); }
    .pending-label { color: #ffb340; font-size: 10px; margin-bottom: 4px; } .pending-card strong { font-size: 12px; }
    .pending-card p { color: #c7c7cc; font-size: 10px; margin: 5px 0 8px; max-height: 34px; overflow: hidden; }
    .actions, .question-options { display: flex; gap: 5px; flex-wrap: wrap; } .actions button, .question-options button, .send-button { border-radius: 8px; background: rgba(255,255,255,.1); padding: 6px 8px; font-size: 10px; }
    .actions .deny { color: #ff6961; } .primary { background: #7c3aed !important; color: white; }
    .empty { color: #999; font-size: 11px; text-align: center; padding: 12px; }
    .compose-card { width: 330px; } #compose-target { width: 100%; border-radius: 8px; padding: 7px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1); color: #eee; font-size: 11px; }
    .drop-area { min-height: 34px; margin: 8px 0; border: 1px dashed rgba(255,255,255,.2); border-radius: 8px; padding: 8px; color: #999; font-size: 10px; }
    .drag-over .drop-area { border-color: #8b5cf6; color: #c4b5fd; } .file-chip { display: inline-block; background: rgba(139,92,246,.25); border-radius: 5px; padding: 4px 6px; margin: 2px; color: #ddd; }
    #compose-input { width: 100%; resize: none; border: 1px solid rgba(255,255,255,.13); border-radius: 9px; background: rgba(0,0,0,.22); color: white; padding: 8px; outline: none; font-size: 12px; }
    #compose-input:focus { border-color: #8b5cf6; } .compose-footer { justify-content: flex-end; margin-top: 7px; } .attach-button { color: #aaa; font-size: 10px; cursor: pointer; padding: 6px; } .attach-button input { display: none; }
    .compose-error { color: #ff6961; font-size: 10px; margin: 5px 0 0; }
  `
  document.head.appendChild(style)
  installDomHandlers()
  render()
})
