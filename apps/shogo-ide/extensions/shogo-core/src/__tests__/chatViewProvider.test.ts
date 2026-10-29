import { beforeEach, describe, expect, test } from 'bun:test'
import { FakeUri, resetVscodeMock, state } from './vscode-mock'

const { ShogoChatViewProvider } = await import('../chatViewProvider')
const { ShogoContextOutbox } = await import('../contextOutbox')

function fakeView() {
  const posted: any[] = []
  let onMessage: (msg: unknown) => unknown = () => {}
  const view = {
    visible: true,
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: unknown) => u,
      postMessage: async (msg: unknown) => {
        posted.push(msg)
        return true
      },
      onDidReceiveMessage: (listener: (msg: unknown) => unknown) => {
        onMessage = listener
        return { dispose() {} }
      },
    },
  }
  return { view, posted, send: (msg: unknown) => onMessage(msg) }
}

function setup() {
  const outbox = new ShogoContextOutbox()
  const provider = new ShogoChatViewProvider(FakeUri.file('/ext') as any, {
    agentClient: { getHealth: async () => ({}) as any, sendChat: async () => ({}) as any },
    contextOutbox: outbox,
  })
  const v = fakeView()
  provider.resolveWebviewView(v.view as any)
  return { provider, outbox, ...v }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
/** Messages are handled asynchronously (`void this.handleMessage(...)`). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush()
}

beforeEach(() => resetVscodeMock())

describe('ShogoChatViewProvider', () => {
  test('the IDE context no longer carries storedContext', async () => {
    const { posted } = setup()
    await flush()
    const ctx = posted.filter((m) => m.type === 'shogo.ide.context' || m.type === 'ide.context')
    expect(ctx.length).toBeGreaterThan(0)
    for (const m of ctx) expect('storedContext' in m).toBe(false)
  })

  test('pending batches are posted, re-sent on ready, and dropped once acknowledged', async () => {
    const { provider, outbox, posted, send } = setup()
    const batchId = outbox.enqueue([{ type: 'file', path: 'a.ts', name: 'a.ts' }])
    await provider.postPendingReferences()
    const sent = () => posted.filter((m) => m.type === 'shogo.ide.addReferences')
    expect(sent()).toEqual([{ type: 'shogo.ide.addReferences', batchId, references: [{ type: 'file', path: 'a.ts', name: 'a.ts' }] }])

    send({ type: 'shogo.ide.ready' })
    await settle()
    expect(sent()).toHaveLength(2)

    send({ type: 'shogo.ide.referencesAck', batchId })
    await settle()
    expect(outbox.pending()).toEqual([])
    send({ type: 'shogo.ide.ready' })
    await settle()
    expect(sent()).toHaveLength(2)
  })

  test('the relay whitelists the new message types in both directions', () => {
    const { view } = setup()
    const html = view.webview.html
    const iframeToIde = /iframeToIdeMessages = new Set\(\[([\s\S]*?)\]\)/.exec(html)![1]
    const ideToIframe = /ideToIframeMessages = new Set\(\[([\s\S]*?)\]\)/.exec(html)![1]
    expect(iframeToIde).toContain("'shogo.ide.referencesAck'")
    expect(ideToIframe).toContain("'shogo.ide.addReferences'")
  })

  test('the relay forwards chat messages only from the chat frame, and host messages only from the host', () => {
    const { view } = setup()
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(view.webview.html)![1]
    const toExtension: any[] = []
    const toChat: any[] = []
    const chatWindow = { postMessage: (m: unknown) => toChat.push(m) }
    const frame = { contentWindow: chatWindow, addEventListener: () => {} }
    const listeners: Array<(event: { data: unknown; source: unknown }) => void> = []
    const webviewWindow: any = { parent: {}, addEventListener: (_type: string, fn: any) => listeners.push(fn) }
    const document = { getElementById: (id: string) => (id === 'chatFrame' ? frame : null) }
    new Function('window', 'document', 'acquireVsCodeApi', script)(webviewWindow, document, () => ({
      postMessage: (m: unknown) => toExtension.push(m),
    }))
    const dispatch = (data: unknown, source: unknown) => listeners.forEach((fn) => fn({ data, source }))
    const nested = { postMessage: () => {} }

    dispatch({ type: 'shogo.ide.referencesAck', batchId: 'b1' }, chatWindow)
    dispatch({ type: 'shogo.ide.referencesAck', batchId: 'spoof' }, nested)
    dispatch({ type: 'shogo.ide.referencesAck', batchId: 'spoof-host' }, null)
    expect(toExtension).toEqual([{ type: 'shogo.ide.referencesAck', batchId: 'b1' }])

    dispatch({ type: 'shogo.ide.addReferences', batchId: 'b2', references: [] }, null)
    dispatch({ type: 'shogo.ide.addReferences', batchId: 'spoof', references: [] }, nested)
    dispatch({ type: 'shogo.ide.addReferences', batchId: 'loop', references: [] }, chatWindow)
    expect(toChat).toEqual([{ type: 'shogo.ide.addReferences', batchId: 'b2', references: [] }])
  })

  test('reports whether the chat is connected', () => {
    const { provider } = setup()
    expect(provider.isChatConnected()).toBe(true)
    state.chatUrl = 'about:blank'
    expect(provider.isChatConnected()).toBe(false)
  })
})
