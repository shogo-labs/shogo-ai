import {
  createChatClient,
  type ChatClient,
  type ChatClientConfig,
  type ChatStatus,
} from './index.js'

export interface EmbedOptions extends Omit<ChatClientConfig, 'apiUrl' | 'projectId'> {
  apiUrl?: string
  projectId?: string
  mode?: 'launcher' | 'page'
  target?: string
  title?: string
  subtitle?: string
  primaryColor?: string
  position?: 'bottom-right' | 'bottom-left'
  placeholder?: string
  poweredBy?: boolean
  frameUrl?: string
}

export interface ShogoEmbedController {
  open(): void
  close(): void
  toggle(): void
  identify(visitor: ChatClientConfig['visitor']): void
  sendMessage(text: string): Promise<void>
  client: ChatClient
}

declare global {
  interface Window {
    ShogoChat?: ShogoEmbedController & { init?: (options: EmbedOptions) => ShogoEmbedController }
  }
}

export function installEmbed(options: EmbedOptions = {}): ShogoEmbedController {
  const script = document.currentScript as HTMLScriptElement | null
  const scriptOptions = script ? optionsFromScript(script) : {}
  const merged = { ...scriptOptions, ...options }
  const apiUrl = merged.apiUrl || (script ? new URL(script.src).origin : window.location.origin)
  const client = createChatClient({ ...merged, projectId: merged.projectId || '', apiUrl, transport: merged.transport || 'runtime' })
  const mode = merged.mode || (script?.dataset.mode === 'page' ? 'page' : 'launcher')
  const frameUrl = merged.frameUrl || `${apiUrl.replace(/\/+$/, '')}/embed/v1/index.html`
  const controller = createController(client, merged, mode, frameUrl)
  window.ShogoChat = controller
  if (mode === 'page') {
    mountPage(controller, merged.target || script?.dataset.target || '#shogo-chat')
  } else {
    mountLauncher(controller)
  }
  return controller
}

function createController(
  client: ChatClient,
  options: EmbedOptions,
  mode: 'launcher' | 'page',
  frameUrl: string,
): ShogoEmbedController {
  let iframe: HTMLIFrameElement | null = null
  let open = mode === 'page'

  const ensureFrame = () => {
    if (iframe) return iframe
    iframe = document.createElement('iframe')
    iframe.title = options.title || 'Chat'
    iframe.allow = 'clipboard-write'
    iframe.style.cssText = mode === 'page'
      ? 'width:100%;height:100%;border:0;display:block;'
      : 'position:fixed;right:20px;bottom:84px;width:min(400px,calc(100vw - 40px));height:min(640px,calc(100vh - 110px));border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.2);z-index:2147482999;display:none;background:#fff;'
    const url = new URL(frameUrl, window.location.href)
    url.searchParams.set('transport', options.transport || 'runtime')
    url.searchParams.set('projectId', options.projectId || '')
    if (options.publishableKey) url.searchParams.set('publishableKey', options.publishableKey)
    if (options.widgetKey) url.searchParams.set('widgetKey', options.widgetKey)
    if (options.agentName) url.searchParams.set('agentName', options.agentName)
    url.searchParams.set('frame', '1')
    url.searchParams.set('parentOrigin', window.location.origin)
    url.searchParams.set('title', options.title || '')
    url.searchParams.set('subtitle', options.subtitle || '')
    url.searchParams.set('primaryColor', options.primaryColor || '')
    url.searchParams.set('placeholder', options.placeholder || '')
    url.searchParams.set('poweredBy', String(options.poweredBy !== false))
    iframe.src = url.toString()
    iframe.addEventListener('load', () => {
      iframe?.contentWindow?.postMessage({ type: 'shogo-chat:init', options }, '*')
    })
    window.addEventListener('message', (event) => {
      if (event.source !== iframe?.contentWindow) return
      if (event.data?.type === 'shogo-chat:resize' && mode === 'launcher') {
        iframe!.style.height = `${Math.min(700, Math.max(360, Number(event.data.height) || 600))}px`
      }
    })
    return iframe
  }

  return {
    client,
    open() {
      const element = ensureFrame()
      const target = mode === 'page' && options.target
        ? document.querySelector(options.target)
        : document.body
      if (!target) throw new Error(`ShogoChat target not found: ${options.target}`)
      if (!element.parentNode) target.appendChild(element)
      open = true
      if (mode === 'launcher') element.style.display = 'block'
      element.contentWindow?.postMessage({ type: 'shogo-chat:open' }, '*')
    },
    close() {
      open = false
      if (iframe && mode === 'launcher') iframe.style.display = 'none'
      iframe?.contentWindow?.postMessage({ type: 'shogo-chat:close' }, '*')
    },
    toggle() {
      if (open) this.close()
      else this.open()
    },
    identify(visitor) {
      client.identify(visitor || {})
      iframe?.contentWindow?.postMessage({ type: 'shogo-chat:identify', visitor }, '*')
    },
    sendMessage(text) {
      const element = ensureFrame()
      const target = mode === 'page' && options.target
        ? document.querySelector(options.target)
        : document.body
      if (!target) return Promise.reject(new Error(`ShogoChat target not found: ${options.target}`))
      if (!element.parentNode) target.appendChild(element)
      if (mode === 'launcher') element.style.display = 'block'
      const send = () => element.contentWindow?.postMessage({ type: 'shogo-chat:send', text }, '*')
      if (element.contentDocument?.readyState === 'complete') send()
      else element.addEventListener('load', send, { once: true })
      return Promise.resolve()
    },
  }
}

function mountLauncher(controller: ShogoEmbedController): void {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', 'Open chat')
  button.textContent = '○'
  button.style.cssText = 'position:fixed;right:20px;bottom:20px;width:56px;height:56px;border:0;border-radius:50%;background:var(--shogo-chat-primary,#6366f1);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.2);font-size:24px;z-index:2147483000;cursor:pointer;'
  button.addEventListener('click', () => controller.toggle())
  document.body.appendChild(button)
}

function mountPage(controller: ShogoEmbedController, target: string): void {
  const element = document.querySelector(target)
  if (!element) throw new Error(`ShogoChat target not found: ${target}`)
  controller.open()
}

function optionsFromScript(script: HTMLScriptElement): Partial<EmbedOptions> {
  const data = script.dataset
  const parseBoolean = (value: string | undefined) => value === undefined ? undefined : value !== 'false'
  return {
    apiUrl: data.apiUrl,
    projectId: data.projectId || new URL(script.src).searchParams.get('projectId') || '',
    publishableKey: data.publishableKey || new URL(script.src).searchParams.get('publishableKey') || undefined,
    widgetKey: data.widgetKey || new URL(script.src).searchParams.get('widgetKey') || undefined,
    transport: (data.transport as EmbedOptions['transport']) || undefined,
    mode: (data.mode as EmbedOptions['mode']) || undefined,
    target: data.target,
    title: data.title,
    subtitle: data.subtitle,
    primaryColor: data.primaryColor,
    position: data.position as EmbedOptions['position'],
    placeholder: data.placeholder,
    poweredBy: parseBoolean(data.poweredBy),
  }
}

function installFrameEmbed(): ShogoEmbedController {
  const params = new URLSearchParams(window.location.search)
  const options: EmbedOptions = {
    apiUrl: params.get('apiUrl') || window.location.origin,
    projectId: params.get('projectId') || '',
    publishableKey: params.get('publishableKey') || undefined,
    widgetKey: params.get('widgetKey') || undefined,
    agentName: params.get('agentName') || undefined,
    transport: (params.get('transport') as EmbedOptions['transport']) || 'runtime',
    title: params.get('title') || undefined,
    subtitle: params.get('subtitle') || undefined,
    primaryColor: params.get('primaryColor') || undefined,
    placeholder: params.get('placeholder') || undefined,
    poweredBy: params.get('poweredBy') !== 'false',
    embedOrigin: params.get('parentOrigin') || (document.referrer ? new URL(document.referrer).origin : undefined),
  }
  const client = createChatClient(options as ChatClientConfig)
  const root = document.createElement('div')
  root.className = 'shogo-chat shogo-chat-frame'
  root.style.cssText = 'height:100vh;display:flex;flex-direction:column;'
  root.innerHTML = `
    <style>${FRAME_CSS}</style>
    <header class="shogo-chat__header"><div class="shogo-chat__avatar">S</div><div class="shogo-chat__header-title"><strong>${escapeHtml(options.title || 'Chat with us')}</strong><span>${escapeHtml(options.subtitle || '')}</span></div></header>
    <div class="shogo-chat__thread" role="log" aria-live="polite"><div class="shogo-chat__empty">How can we help?</div></div>
    <div class="shogo-chat__suggestions"></div>
    <div class="shogo-chat__composer"><textarea rows="1" aria-label="Message"></textarea><button class="shogo-chat__send" type="button">Send</button></div>
    ${options.poweredBy === false ? '' : '<div class="shogo-chat__powered">Powered by Shogo</div>'}
  `
  document.body.style.margin = '0'
  document.body.appendChild(root)
  const thread = root.querySelector('.shogo-chat__thread')!
  const input = root.querySelector('textarea') as HTMLTextAreaElement
  const send = root.querySelector('.shogo-chat__send') as HTMLButtonElement
  input.placeholder = options.placeholder || 'Type a message...'
  let status: ChatStatus = 'ready'
  const render = () => {
    const messages = client.getSnapshot().messages
    thread.innerHTML = ''
    for (const message of messages) {
      const item = document.createElement('div')
      item.className = `shogo-chat__message shogo-chat__message--${message.role}`
      item.textContent = message.parts
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text || '')
        .join('')
      thread.appendChild(item)
    }
    if (status === 'streaming') {
      const loading = document.createElement('span')
      loading.className = 'shogo-chat__loading'
      loading.textContent = '…'
      thread.appendChild(loading)
    }
    thread.scrollTop = thread.scrollHeight
    send.textContent = status === 'streaming' || status === 'submitted' ? 'Stop' : 'Send'
    send.disabled = status !== 'streaming' && status !== 'submitted' && !input.value.trim()
    window.parent.postMessage({ type: 'shogo-chat:resize', height: root.scrollHeight }, '*')
  }
  client.on('status', ({ status: next }) => {
    status = next
    render()
  })
  send.addEventListener('click', () => {
    if (status === 'streaming' || status === 'submitted') void client.stop()
    else {
      const text = input.value
      input.value = ''
      void client.send(text)
    }
    render()
  })
  input.addEventListener('input', render)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send.click()
    }
  })
  window.addEventListener('message', (event) => {
    const parentOrigin = options.embedOrigin
    if (event.source !== window.parent || (parentOrigin && event.origin !== parentOrigin)) return
    if (event.data?.type === 'shogo-chat:identify') client.identify(event.data.visitor || {})
    if (event.data?.type === 'shogo-chat:send') void client.send(String(event.data.text || ''))
  })
  void client.initRuntime().catch(() => {})
  render()

  const controller: ShogoEmbedController = {
    client,
    open() { root.style.display = 'flex'; window.parent.postMessage({ type: 'shogo-chat:open' }, '*') },
    close() { root.style.display = 'none'; window.parent.postMessage({ type: 'shogo-chat:close' }, '*') },
    toggle() { root.style.display = root.style.display === 'none' ? 'flex' : 'none' },
    identify(visitor) { client.identify(visitor || {}) },
    sendMessage(text) { return client.send(text) },
  }
  window.ShogoChat = controller
  return controller
}

const FRAME_CSS = `
  .shogo-chat{--shogo-chat-primary:#6366f1;--shogo-chat-background:#fff;--shogo-chat-foreground:#171717;--shogo-chat-muted:#737373;--shogo-chat-border:#e5e5e5;font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;color:var(--shogo-chat-foreground);background:var(--shogo-chat-background)}
  .shogo-chat *{box-sizing:border-box}.shogo-chat__header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--shogo-chat-border)}.shogo-chat__header-title{flex:1;min-width:0}.shogo-chat__header-title strong,.shogo-chat__header-title span{display:block}.shogo-chat__header-title span{color:var(--shogo-chat-muted);font-size:12px}.shogo-chat__avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--shogo-chat-primary);color:#fff;font-weight:700}.shogo-chat__thread{display:flex;flex:1;flex-direction:column;gap:16px;overflow:auto;padding:18px}.shogo-chat__message{max-width:88%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}.shogo-chat__message--user{align-self:flex-end;background:var(--shogo-chat-primary);color:#fff}.shogo-chat__message--assistant{align-self:flex-start;background:#f5f5f5}.shogo-chat__composer{display:flex;gap:8px;padding:12px;border-top:1px solid var(--shogo-chat-border)}.shogo-chat__composer textarea{flex:1;resize:none;border:1px solid var(--shogo-chat-border);border-radius:10px;padding:9px 11px}.shogo-chat__send{min-width:72px;border:0;border-radius:10px;background:var(--shogo-chat-primary);color:#fff}.shogo-chat__send:disabled{opacity:.5}.shogo-chat__powered{text-align:center;padding:6px;color:var(--shogo-chat-muted);font-size:10px;border-top:1px solid var(--shogo-chat-border)}
`

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] || character))
}

export function autoInstallEmbed(): ShogoEmbedController | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  if (window.ShogoChat) return window.ShogoChat
  if (new URL(window.location.href).searchParams.get('frame') === '1') {
    return installFrameEmbed()
  }
  const script = document.currentScript as HTMLScriptElement | null
  if (!script) return null
  return installEmbed()
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autoInstallEmbed(), { once: true })
  } else {
    autoInstallEmbed()
  }
}

export type { ChatStatus }
