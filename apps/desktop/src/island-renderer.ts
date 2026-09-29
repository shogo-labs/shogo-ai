// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Island UI. Bundled for the browser by scripts/bundle-main.mjs and loaded
// by island.html; talks to the main process only through `window.shogoIsland`.

import { ISLAND_MAX_FILES, validateIslandFiles } from './island-attachments'
import type {
  IslandAction,
  IslandBridge,
  IslandFileRef,
  IslandMode,
  IslandPending,
  IslandSession,
  IslandSnapshot,
  IslandTarget,
} from './island-protocol'

declare global {
  interface Window {
    shogoIsland: IslandBridge
  }
}

const bridge = window.shogoIsland

const HOVER_EXPAND_DELAY_MS = 350
const HOVER_COLLAPSE_DELAY_MS = 700

let snapshot: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 0 }
let mode: IslandMode = 'hidden'
let composeTarget: IslandTarget | null = null
let composeFiles: IslandFileRef[] = []
let composeError = ''
let sending = false
let pendingError = ''
let renderedPendingKey = ''
let renderedTargetsKey = ''
let targetOptions: IslandTarget[] = []

function $(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`island.html is missing #${id}`)
  return element
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; dataset?: Record<string, string>; attrs?: Record<string, string> } = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.className) node.className = props.className
  if (props.text !== undefined) node.textContent = props.text
  for (const [key, value] of Object.entries(props.dataset ?? {})) node.dataset[key] = value
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value)
  node.append(...children)
  return node
}

function hasPending(): boolean {
  return snapshot.sessions.some((session) => !!session.pending)
}

function requestMode(next: IslandMode): void {
  if (next === mode) return
  mode = next
  bridge.setMode(next)
  render()
}

async function runAction(action: IslandAction): Promise<boolean> {
  const result = await bridge.sendAction(action)
  if (!result.ok) {
    if (action.type === 'send') composeError = result.error
    else pendingError = result.error
    render()
  }
  return result.ok
}

// ── Rendering ────────────────────────────────────────────────────────────

function render(): void {
  for (const view of ['hidden', 'collapsed', 'expanded', 'compose'] as const) {
    $(`view-${view}`).hidden = view !== mode
  }
  if (mode === 'collapsed') renderCollapsed()
  else if (mode === 'expanded') renderExpanded()
  else if (mode === 'compose') renderCompose()
  requestAnimationFrame(updateInteractive)
}

function renderCollapsed(): void {
  const attention = snapshot.sessions.some(
    (session) => session.status === 'needs_approval' || session.status === 'needs_answer',
  )
  $('collapsed-dot').classList.toggle('attention', attention)
  $('collapsed-label').textContent = snapshot.sessions.length ? `${snapshot.sessions.length} active` : 'Shogo'
}

interface SessionRow {
  root: HTMLElement
  dot: HTMLElement
  title: HTMLElement
  step: HTMLElement
  preview: HTMLElement
}

/** Rows are keyed and patched in place: streaming updates the preview many
 * times a second, and replacing the buttons would drop clicks in flight. */
const sessionRows = new Map<string, SessionRow>()
const emptySessions = el('p', { className: 'empty', text: 'No open chat sessions' })

function createSessionRow(session: IslandSession): SessionRow {
  const dot = el('span')
  const title = el('strong')
  const step = el('small')
  const preview = el('p', { className: 'preview' })
  const root = el('div', {}, [
    el('div', { className: 'session-row' }, [
      el('button', { className: 'session-main', dataset: { openProject: session.projectId, openSession: session.sessionId } }, [
        dot,
        el('span', { className: 'session-copy' }, [title, step]),
      ]),
      el('button', {
        className: 'reply-button',
        text: '↩',
        dataset: { replyProject: session.projectId, replySession: session.sessionId },
        attrs: { 'aria-label': 'Reply in chat' },
      }),
    ]),
    preview,
  ])
  return { root, dot, title, step, preview }
}

function renderSessions(): void {
  const container = $('sessions')
  const live = new Set<string>()
  const nodes = snapshot.sessions.map((session) => {
    const key = `${session.projectId}:${session.sessionId}`
    live.add(key)
    let row = sessionRows.get(key)
    if (!row) {
      row = createSessionRow(session)
      sessionRows.set(key, row)
    }
    row.dot.className = `status-dot ${session.status}`
    row.title.textContent = session.title || 'Untitled chat'
    row.step.textContent = session.step || session.status.replaceAll('_', ' ')
    row.preview.textContent = session.replyPreview ?? ''
    row.preview.hidden = !session.replyPreview
    return row.root
  })
  for (const key of sessionRows.keys()) {
    if (!live.has(key)) sessionRows.delete(key)
  }
  const next = nodes.length ? nodes : [emptySessions]
  const current = Array.from(container.children)
  if (current.length !== next.length || current.some((node, index) => node !== next[index])) {
    container.replaceChildren(...next)
  }
}

function renderExpanded(): void {
  const notice = $('notice')
  notice.hidden = !snapshot.notice
  notice.textContent = snapshot.notice ?? ''

  renderSessions()

  const owner = snapshot.sessions.find((session) => session.pending)
  const key = owner?.pending ? `${owner.pending.kind}:${owner.pending.request.id}:${pendingError}` : ''
  if (key !== renderedPendingKey) {
    renderedPendingKey = key
    $('pending').replaceChildren(...(owner?.pending ? [renderPending(owner, owner.pending)] : []))
  }
  updateCountdown()
}

function renderPending(owner: IslandSession, pending: IslandPending): HTMLElement {
  const errorNode = pendingError ? [el('p', { className: 'compose-error', text: pendingError })] : []
  if (pending.kind === 'permission') {
    const { request } = pending
    return el('section', { className: 'pending-card' }, [
      el('div', { className: 'pending-label', attrs: { id: 'pending-countdown' } }),
      el('strong', { text: request.toolName || 'Tool request' }),
      el('p', { text: request.reason || summarizeParams(request.params) }),
      ...errorNode,
      el('div', { className: 'actions' }, [
        el('button', { className: 'deny', text: 'Deny', dataset: { permission: 'deny', requestId: request.id } }),
        el('button', { text: 'Allow once', dataset: { permission: 'allow_once', requestId: request.id } }),
        el('button', {
          className: 'primary',
          text: 'Always',
          dataset: { permission: 'always_allow', requestId: request.id, pattern: permissionPattern(request.params) },
        }),
      ]),
    ])
  }

  const { request } = pending
  const actions = request.answerInApp
    ? [
        el('button', {
          className: 'primary',
          text: 'Answer in Shogo',
          dataset: { openProject: owner.projectId, openSession: owner.sessionId },
        }),
      ]
    : request.options.map((option) =>
        el('button', {
          text: option.label,
          dataset: { question: option.label, requestId: request.id },
          ...(option.description ? { attrs: { title: option.description } } : {}),
        }),
      )
  return el('section', { className: 'pending-card' }, [
    el('div', { className: 'pending-label', text: 'Shogo needs an answer' }),
    el('strong', { text: request.prompt || 'Choose an option' }),
    ...errorNode,
    el('div', { className: 'actions' }, actions),
  ])
}

function updateCountdown(): void {
  const label = document.getElementById('pending-countdown')
  const pending = snapshot.sessions.find((session) => session.pending?.kind === 'permission')?.pending
  if (!label || pending?.kind !== 'permission') return
  const { timeout, startedAt } = pending.request
  if (timeout <= 0) {
    label.textContent = 'Permission needed'
    return
  }
  const remaining = Math.max(0, timeout - Math.floor((Date.now() - startedAt) / 1000))
  label.textContent = remaining > 0 ? `Permission needed · ${remaining}s` : 'Permission request timed out'
}

function summarizeParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([key]) => key !== 'timeout' && key !== 'category')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ')
    .slice(0, 260)
}

function permissionPattern(params: Record<string, unknown>): string {
  for (const key of ['command', 'path', 'url', 'name']) {
    if (typeof params[key] === 'string') return params[key] as string
  }
  return ''
}

function sameTarget(a: IslandTarget, b: IslandTarget): boolean {
  if (a.kind !== b.kind || a.projectId !== b.projectId) return false
  return a.kind === 'new' || (b.kind === 'session' && a.sessionId === b.sessionId)
}

function currentTarget(): IslandTarget | null {
  if (composeTarget && targetOptions.some((option) => sameTarget(option, composeTarget!))) return composeTarget
  return targetOptions[0] ?? null
}

/** Updates compose chrome in place. The textarea is never rebuilt, so
 * snapshot ticks can't steal the caret, selection, or IME composition. */
function renderCompose(): void {
  targetOptions = [
    ...snapshot.sessions.map((s): IslandTarget => ({ kind: 'session', projectId: s.projectId, sessionId: s.sessionId })),
    ...snapshot.recentProjects.map((p): IslandTarget => ({ kind: 'new', projectId: p.projectId })),
  ]
  const labels = [
    ...snapshot.sessions.map((s) => `Reply in: ${s.title || 'Untitled chat'}`),
    ...snapshot.recentProjects.map((p) => `New chat in: ${p.name || 'Project'}`),
  ]
  const select = $('compose-target') as HTMLSelectElement
  const targetsKey = JSON.stringify([targetOptions, labels])
  if (targetsKey !== renderedTargetsKey) {
    renderedTargetsKey = targetsKey
    select.replaceChildren(
      ...(labels.length
        ? labels.map((label, index) => el('option', { text: label, attrs: { value: String(index) } }))
        : [el('option', { text: 'Open a project in Shogo first', attrs: { value: '' } })]),
    )
  }
  const target = currentTarget()
  select.disabled = !target
  if (target) select.value = String(targetOptions.findIndex((option) => sameTarget(option, target)))

  $('drop-area').replaceChildren(
    ...(composeFiles.length
      ? composeFiles.map((file) => el('span', { className: 'file-chip', text: file.name }))
      : [document.createTextNode('Drop files here or use Attach')]),
  )
  const error = $('compose-error')
  error.hidden = !composeError
  error.textContent = composeError

  const input = $('compose-input') as HTMLTextAreaElement
  ;($('send-button') as HTMLButtonElement).disabled =
    sending || !target || (!input.value.trim() && composeFiles.length === 0)
}

// ── Compose ──────────────────────────────────────────────────────────────

function addFiles(files: readonly File[]): void {
  const room = ISLAND_MAX_FILES - composeFiles.length
  const selected = files.slice(0, Math.max(0, room))
  const invalid =
    room <= 0 ? `Maximum ${ISLAND_MAX_FILES} files allowed` : validateIslandFiles(selected)
  if (invalid) {
    composeError = invalid
    render()
    return
  }
  const refs = selected.map((file) => ({ path: bridge.getPathForFile(file), name: file.name, type: file.type }))
  if (refs.some((ref) => !ref.path)) {
    composeError = 'Only files saved on disk can be attached here'
  } else {
    composeFiles = [...composeFiles, ...refs]
    composeError = files.length > room ? `Maximum ${ISLAND_MAX_FILES} files allowed` : ''
  }
  render()
}

async function sendCompose(): Promise<void> {
  const input = $('compose-input') as HTMLTextAreaElement
  const target = currentTarget()
  const text = input.value
  if (sending || !target || (!text.trim() && composeFiles.length === 0)) return
  sending = true
  composeError = ''
  render()
  const ok = await runAction({
    type: 'send',
    target,
    text,
    ...(composeFiles.length ? { files: composeFiles } : {}),
  })
  sending = false
  if (ok) {
    input.value = ''
    composeFiles = []
    requestMode('collapsed')
  } else {
    render()
  }
}

function openCompose(target: IslandTarget | null): void {
  composeTarget = target
  composeError = ''
  requestMode('compose')
  render()
  const input = $('compose-input') as HTMLTextAreaElement
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

function containsDirectory(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.items ?? []).some((item) => item.webkitGetAsEntry?.()?.isDirectory === true)
}

// ── Pointer: click-through and hover ─────────────────────────────────────

let lastPoint: { x: number; y: number } | null = null
let interactive = false
let expandTimer: ReturnType<typeof setTimeout> | null = null
let collapseTimer: ReturnType<typeof setTimeout> | null = null

function elementUnderPointer(): Element | null {
  return lastPoint ? document.elementFromPoint(lastPoint.x, lastPoint.y) : null
}

function updateInteractive(): void {
  const over = !!elementUnderPointer()?.closest('.surface')
  if (over === interactive) return
  interactive = over
  bridge.setInteractive(over)
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer)
  return null
}

function handleHover(): void {
  const target = elementUnderPointer()
  const overTrigger = !!target?.closest('.hot-zone, .collapsed')
  if ((mode === 'hidden' || mode === 'collapsed') && overTrigger) {
    expandTimer ??= setTimeout(() => {
      expandTimer = null
      if (mode === 'hidden' || mode === 'collapsed') requestMode('expanded')
    }, HOVER_EXPAND_DELAY_MS)
  } else {
    expandTimer = clearTimer(expandTimer)
  }

  if (mode === 'expanded' && !target?.closest('.surface')) scheduleCollapse()
  else collapseTimer = clearTimer(collapseTimer)
}

function scheduleCollapse(): void {
  collapseTimer ??= setTimeout(() => {
    collapseTimer = null
    if (mode === 'expanded' && !hasPending()) requestMode('collapsed')
  }, HOVER_COLLAPSE_DELAY_MS)
}

// ── Event wiring ─────────────────────────────────────────────────────────

function installDomHandlers(): void {
  document.addEventListener('mousemove', (event) => {
    lastPoint = { x: event.clientX, y: event.clientY }
    updateInteractive()
    handleHover()
  })
  document.addEventListener('mouseleave', () => {
    lastPoint = null
    updateInteractive()
    expandTimer = clearTimer(expandTimer)
    if (mode === 'expanded') scheduleCollapse()
  })

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const open = target.closest<HTMLElement>('[data-open-project]')
    if (open) {
      void runAction({
        type: 'open',
        projectId: open.dataset.openProject ?? '',
        sessionId: open.dataset.openSession ?? '',
      })
      requestMode('collapsed')
      return
    }
    const reply = target.closest<HTMLElement>('[data-reply-project]')
    if (reply) {
      openCompose({
        kind: 'session',
        projectId: reply.dataset.replyProject ?? '',
        sessionId: reply.dataset.replySession ?? '',
      })
      return
    }
    if (target.closest('[data-compose]')) {
      openCompose(null)
      return
    }
    if (target.closest('[data-collapse]')) {
      requestMode('collapsed')
      return
    }
    if (target.closest('.collapsed')) {
      requestMode('expanded')
      return
    }
    const permission = target.closest<HTMLElement>('[data-permission]')
    if (permission) {
      pendingError = ''
      void runAction({
        type: 'permission',
        requestId: permission.dataset.requestId ?? '',
        decision: permission.dataset.permission as 'allow_once' | 'always_allow' | 'deny',
        ...(permission.dataset.pattern ? { pattern: permission.dataset.pattern } : {}),
      })
      return
    }
    const question = target.closest<HTMLElement>('[data-question]')
    if (question) {
      pendingError = ''
      void runAction({
        type: 'question',
        requestId: question.dataset.requestId ?? '',
        response: question.dataset.question ?? '',
      })
      return
    }
    if (target.closest('#send-button')) void sendCompose()
  })

  $('compose-input').addEventListener('input', () => renderCompose())
  $('compose-target').addEventListener('change', (event) => {
    const index = Number((event.target as HTMLSelectElement).value)
    composeTarget = targetOptions[index] ?? null
  })
  $('file-input').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement
    if (input.files) addFiles(Array.from(input.files))
    input.value = ''
  })

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    if (target.id === 'compose-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendCompose()
    }
    if (event.key === 'Escape') requestMode('collapsed')
  })

  document.addEventListener('dragover', (event) => {
    event.preventDefault()
    document.body.classList.add('drag-over')
  })
  document.addEventListener('dragleave', () => document.body.classList.remove('drag-over'))
  document.addEventListener('drop', (event) => {
    event.preventDefault()
    document.body.classList.remove('drag-over')
    if (containsDirectory(event.dataTransfer)) {
      composeError = 'Folders cannot be attached here'
      if (mode !== 'compose') openCompose(composeTarget)
      else render()
      return
    }
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.length) return
    if (mode !== 'compose') openCompose(composeTarget)
    addFiles(files)
  })

  setInterval(() => {
    if (mode === 'expanded') updateCountdown()
  }, 1000)
}

bridge.onSnapshot((value) => {
  snapshot = value
  if (!snapshot.sessions.some((session) => session.pending)) pendingError = ''
  render()
})
bridge.onLayout((layout) => {
  mode = layout.mode
  document.body.classList.toggle('notched', layout.notched)
  render()
})
bridge.onOpenCompose(() => openCompose(null))

installDomHandlers()
render()
