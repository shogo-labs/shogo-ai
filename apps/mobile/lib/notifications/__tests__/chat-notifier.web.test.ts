// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the web + Electron chat-notifier adapter.
 *
 * The adapter reads `document`, `window`, `Notification`, and (optionally)
 * `window.shogoDesktop`. We stand up a fake DOM environment in Bun and
 * reload the module between scenarios so the internal permission cache and
 * click subscribers start clean.
 *
 * Run: bun test apps/mobile/lib/notifications/__tests__/chat-notifier.web.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

type NotifyMod = typeof import('../chat-notifier.web')

interface FakeDocument {
  hidden: boolean
  hasFocusReturn: boolean
  hasFocus: () => boolean
}

interface FakeNotificationInstance {
  title: string
  options: any
  onclick: null | (() => void)
  closed: boolean
}

interface FakeNotificationCtor {
  (this: FakeNotificationInstance, title: string, options: any): void
  permission: NotificationPermission
  requestPermission: () => Promise<NotificationPermission>
  instances: FakeNotificationInstance[]
}

interface DesktopBridgeState {
  isDesktop: boolean
  isWindowFocusedReturn: boolean
  showChatNotificationCalls: any[]
  showChatNotificationImpl?: (args: any) => Promise<void>
  onNotificationClickedCalls: Array<(d: any) => void>
  removeListenerCalls: number
}

function makeFakeDocument(overrides?: Partial<FakeDocument>): FakeDocument {
  const d: FakeDocument = {
    hidden: false,
    hasFocusReturn: true,
    hasFocus() {
      return this.hasFocusReturn
    },
    ...overrides,
  }
  d.hasFocus = d.hasFocus.bind(d)
  return d
}

function installEnv(options?: {
  document?: FakeDocument
  desktop?: Partial<DesktopBridgeState>
  withNotification?: boolean
  initialPermission?: NotificationPermission
  requestPermissionResult?: NotificationPermission
}) {
  const doc = options?.document ?? makeFakeDocument()
  ;(globalThis as any).document = doc

  const desktopState: DesktopBridgeState | null = options?.desktop
    ? {
        isDesktop: options.desktop.isDesktop ?? true,
        isWindowFocusedReturn: options.desktop.isWindowFocusedReturn ?? true,
        showChatNotificationCalls: [],
        showChatNotificationImpl: options.desktop.showChatNotificationImpl,
        onNotificationClickedCalls: [],
        removeListenerCalls: 0,
      }
    : null

  const win: any = {
    focus: () => {},
  }
  if (desktopState) {
    win.shogoDesktop = {
      isDesktop: desktopState.isDesktop,
      showChatNotification: async (args: any) => {
        desktopState.showChatNotificationCalls.push(args)
        if (desktopState.showChatNotificationImpl) {
          await desktopState.showChatNotificationImpl(args)
        }
      },
      onNotificationClicked: (cb: (d: any) => void) => {
        desktopState.onNotificationClickedCalls.push(cb)
      },
      removeNotificationClickedListener: () => {
        desktopState.removeListenerCalls += 1
      },
      isWindowFocused: async () => desktopState.isWindowFocusedReturn,
    }
  }
  ;(globalThis as any).window = win

  let notif: FakeNotificationCtor | undefined
  if (options?.withNotification) {
    const instances: FakeNotificationInstance[] = []
    const Ctor = function (this: FakeNotificationInstance, title: string, opts: any) {
      this.title = title
      this.options = opts
      this.onclick = null
      this.closed = false
      instances.push(this)
    } as unknown as FakeNotificationCtor
    Ctor.permission = options.initialPermission ?? 'default'
    Ctor.requestPermission = async () => {
      const next = options.requestPermissionResult ?? 'granted'
      Ctor.permission = next
      return next
    }
    Ctor.instances = instances
    // prototype close
    ;(Ctor as any).prototype = {
      close(this: FakeNotificationInstance) {
        this.closed = true
      },
    }
    notif = Ctor
    ;(globalThis as any).Notification = Ctor
  } else {
    delete (globalThis as any).Notification
  }

  return { doc, desktop: desktopState, notif, win }
}

function uninstallEnv() {
  // Restore happy-dom's preload-installed globals rather than deleting
  // them — otherwise downstream RTL tests crash with `document is not
  // defined` when run in the same process.
  if (ORIGINALS.document !== undefined) {
    ;(globalThis as any).document = ORIGINALS.document
  } else {
    delete (globalThis as any).document
  }
  if (ORIGINALS.window !== undefined) {
    ;(globalThis as any).window = ORIGINALS.window
  } else {
    delete (globalThis as any).window
  }
  if (ORIGINALS.Notification !== undefined) {
    ;(globalThis as any).Notification = ORIGINALS.Notification
  } else {
    delete (globalThis as any).Notification
  }
}

const ORIGINALS = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  document: (globalThis as any).document,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window: (globalThis as any).window,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Notification: (globalThis as any).Notification,
}

async function freshModule(): Promise<NotifyMod> {
  const path = require.resolve('../chat-notifier.web')
  // Bun caches modules like Node; clear the entry before import so internal
  // state (permissionCache, clickListeners) starts fresh each test.
  if ((require as any).cache && (require as any).cache[path]) {
    delete (require as any).cache[path]
  }
  return (await import('../chat-notifier.web?t=' + Math.random())) as NotifyMod
}

describe('chat-notifier.web — isUserInactive (browser path)', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('returns true when document.hidden', async () => {
    installEnv({
      document: makeFakeDocument({ hidden: true, hasFocusReturn: true }),
    })
    const mod = await freshModule()
    expect(await mod.isUserInactive()).toBe(true)
  })

  test('returns true when document has no focus', async () => {
    installEnv({
      document: makeFakeDocument({ hidden: false, hasFocusReturn: false }),
    })
    const mod = await freshModule()
    expect(await mod.isUserInactive()).toBe(true)
  })

  test('returns false when visible and focused', async () => {
    installEnv({
      document: makeFakeDocument({ hidden: false, hasFocusReturn: true }),
    })
    const mod = await freshModule()
    expect(await mod.isUserInactive()).toBe(false)
  })
})

describe('chat-notifier.web — isUserInactive (electron path)', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('defers to main-process isWindowFocused when desktop bridge present', async () => {
    installEnv({
      document: makeFakeDocument({ hidden: false, hasFocusReturn: true }),
      desktop: { isDesktop: true, isWindowFocusedReturn: false },
    })
    const mod = await freshModule()
    // Window lies and says focused=true; main process says unfocused, so
    // we should consider the user inactive.
    expect(await mod.isUserInactive()).toBe(true)
  })

  test('returns false when main process reports focused', async () => {
    installEnv({
      document: makeFakeDocument({ hidden: false, hasFocusReturn: false }),
      desktop: { isDesktop: true, isWindowFocusedReturn: true },
    })
    const mod = await freshModule()
    // document.hasFocus() is unreliable on macOS; main process wins.
    expect(await mod.isUserInactive()).toBe(false)
  })

  test('document.hidden short-circuits regardless of desktop focus', async () => {
    installEnv({
      document: makeFakeDocument({ hidden: true, hasFocusReturn: true }),
      desktop: { isDesktop: true, isWindowFocusedReturn: true },
    })
    const mod = await freshModule()
    expect(await mod.isUserInactive()).toBe(true)
  })
})

describe('chat-notifier.web — notifyChatFinished', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('routes to Electron IPC when desktop bridge is present', async () => {
    const { desktop } = installEnv({
      document: makeFakeDocument(),
      desktop: { isDesktop: true },
      withNotification: true,
      initialPermission: 'granted',
    })
    const mod = await freshModule()
    await mod.notifyChatFinished({
      sessionId: 's1',
      projectId: 'p1',
      title: 'Done',
      preview: 'Hello',
    })
    expect(desktop!.showChatNotificationCalls).toHaveLength(1)
    expect(desktop!.showChatNotificationCalls[0]).toEqual({
      title: 'Done',
      body: 'Hello',
      sessionId: 's1',
      projectId: 'p1',
    })
    // Web Notification API should NOT have been used.
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances).toHaveLength(0)
  })

  test('uses Web Notification API when no desktop bridge and permission granted', async () => {
    installEnv({
      document: makeFakeDocument(),
      withNotification: true,
      initialPermission: 'granted',
    })
    const mod = await freshModule()
    await mod.notifyChatFinished({
      sessionId: 's2',
      projectId: 'p2',
      title: 'Reply ready',
      preview: 'body',
    })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances).toHaveLength(1)
    expect(Ctor.instances[0].title).toBe('Reply ready')
    expect(Ctor.instances[0].options.tag).toBe('s2')
    expect(Ctor.instances[0].options.body).toBe('body')
    expect(Ctor.instances[0].options.data).toEqual({ sessionId: 's2', projectId: 'p2' })
  })

  test('no-ops on browser when permission is not granted', async () => {
    installEnv({
      document: makeFakeDocument(),
      withNotification: true,
      initialPermission: 'denied',
    })
    const mod = await freshModule()
    await mod.notifyChatFinished({
      sessionId: 's3',
      projectId: 'p3',
      title: 't',
      preview: 'b',
    })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances).toHaveLength(0)
  })

  test('no-ops when Notification API is unavailable and not on desktop', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: false })
    const mod = await freshModule()
    // Should simply resolve without throwing.
    await expect(
      mod.notifyChatFinished({
        sessionId: 's4',
        projectId: 'p4',
        title: 't',
        preview: 'b',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('chat-notifier.web — ensureNotificationPermission', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('returns true immediately on desktop without touching Notification.requestPermission', async () => {
    let requested = 0
    installEnv({
      document: makeFakeDocument(),
      desktop: { isDesktop: true },
      withNotification: true,
      initialPermission: 'default',
    })
    // Replace requestPermission so we can observe calls.
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    Ctor.requestPermission = async () => {
      requested += 1
      return 'granted'
    }
    const mod = await freshModule()
    expect(await mod.ensureNotificationPermission()).toBe(true)
    expect(requested).toBe(0)
  })

  test('never prompts outside a click: default permission reports false without asking', async () => {
    installEnv({
      document: makeFakeDocument(),
      withNotification: true,
      initialPermission: 'default',
    })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    Ctor.requestPermission = async () => {
      throw new Error('should not be requested')
    }
    const mod = await freshModule()
    expect(await mod.ensureNotificationPermission()).toBe(false)
  })

  test('picks up a grant made later without a stale cache', async () => {
    installEnv({
      document: makeFakeDocument(),
      withNotification: true,
      initialPermission: 'default',
    })
    const mod = await freshModule()
    expect(await mod.ensureNotificationPermission()).toBe(false)
    ;((globalThis as any).Notification as FakeNotificationCtor).permission = 'granted'
    expect(await mod.ensureNotificationPermission()).toBe(true)
  })

  test('returns false on denied', async () => {
    installEnv({
      document: makeFakeDocument(),
      withNotification: true,
      initialPermission: 'denied',
    })
    const mod = await freshModule()
    expect(await mod.ensureNotificationPermission()).toBe(false)
  })
})

describe('chat-notifier.web — permission state and click-driven request', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('maps browser permission to state', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: true, initialPermission: 'default' })
    const mod = await freshModule()
    expect(await mod.getNotificationPermissionState()).toBe('prompt')
    ;((globalThis as any).Notification as FakeNotificationCtor).permission = 'denied'
    expect(await mod.getNotificationPermissionState()).toBe('denied')
  })

  test('reports unsupported without the Notification API', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: false })
    const mod = await freshModule()
    expect(await mod.getNotificationPermissionState()).toBe('unsupported')
  })

  test('requests from a gesture when undecided', async () => {
    installEnv({
      document: makeFakeDocument(),
      withNotification: true,
      initialPermission: 'default',
      requestPermissionResult: 'granted',
    })
    const mod = await freshModule()
    expect(await mod.requestNotificationPermissionFromGesture()).toBe('granted')
    expect(await mod.ensureNotificationPermission()).toBe(true)
  })

  test('does not re-ask once denied', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: true, initialPermission: 'denied' })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    Ctor.requestPermission = async () => {
      throw new Error('should not be requested')
    }
    const mod = await freshModule()
    expect(await mod.requestNotificationPermissionFromGesture()).toBe('denied')
  })
})

describe('chat-notifier.web — subscribeNotificationClicks', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('channel alerts use the Notification API even on desktop and route clicks to the conversation', async () => {
    installEnv({
      document: makeFakeDocument(),
      desktop: { isDesktop: true },
      withNotification: true,
      initialPermission: 'default',
    })
    const mod = await freshModule()
    const received: unknown[] = []
    mod.subscribeNotificationClicks((d) => {
      received.push(d)
    })

    await mod.notifyChannelMessage({
      conversationId: 'c1',
      messageId: 'm1',
      threadRootId: 'r1',
      title: 'ada in #general',
      body: 'ship it',
    })

    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances[0].title).toBe('ada in #general')
    expect(Ctor.instances[0].options.tag).toBe('thread:r1')
    Ctor.instances[0].onclick!()
    expect(received).toEqual([{ conversationId: 'c1', threadRootId: 'r1' }])
  })

  test('each reply in a thread shares a tag and re-alerts with renotify', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: true, initialPermission: 'granted' })
    const mod = await freshModule()
    const reply = { conversationId: 'c1', messageId: 'm', threadRootId: 'r9', title: 'ada', body: 'x' }
    await mod.notifyChannelMessage({ ...reply, messageId: 'm1' })
    await mod.notifyChannelMessage({ ...reply, messageId: 'm2' })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances.map((i) => i.options.tag)).toEqual(['thread:r9', 'thread:r9'])
    expect(Ctor.instances.every((i) => i.options.renotify === true)).toBe(true)
  })

  test('a channel message without a thread is tagged by its conversation', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: true, initialPermission: 'granted' })
    const mod = await freshModule()
    await mod.notifyChannelMessage({
      conversationId: 'c5', messageId: 'm', threadRootId: null, title: 'ada', body: 'hi',
    })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances[0].options.tag).toBe('channel:c5')
  })

  test('the title carries the reason label when one is given', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: true, initialPermission: 'granted' })
    const mod = await freshModule()
    await mod.notifyChannelMessage({
      conversationId: 'dm1', messageId: 'm', threadRootId: null, title: 'ada', body: 'hi', reason: 'dm',
    })
    await mod.notifyChannelMessage({
      conversationId: 'c1', messageId: 'm2', threadRootId: 'r1', title: 'ada replied in #general', body: 'ok', reason: 'thread',
    })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances[0].title).toBe('Direct message · ada')
    expect(Ctor.instances[1].title).toBe('Thread reply · ada replied in #general')
  })

  test('delivers browser click via the in-page bus', async () => {
    installEnv({
      document: makeFakeDocument(),
      withNotification: true,
      initialPermission: 'granted',
    })
    const mod = await freshModule()

    const received: unknown[] = []
    const unsubscribe = mod.subscribeNotificationClicks((d) => {
      received.push(d)
    })

    await mod.notifyChatFinished({
      sessionId: 's-click',
      projectId: 'p-click',
      title: 't',
      preview: 'b',
    })

    // Simulate the user clicking the notification.
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    const inst = Ctor.instances[0]
    expect(typeof inst.onclick).toBe('function')
    inst.onclick!()

    expect(received).toEqual([{ sessionId: 's-click', projectId: 'p-click' }])

    // Unsubscribing stops further deliveries.
    unsubscribe()
    inst.onclick = null
  })

  test('wires through to the desktop bridge and cleans up on unsubscribe', async () => {
    const { desktop } = installEnv({
      document: makeFakeDocument(),
      desktop: { isDesktop: true },
    })
    const mod = await freshModule()
    const cb = () => {}
    const unsubscribe = mod.subscribeNotificationClicks(cb)

    expect(desktop!.onNotificationClickedCalls).toHaveLength(1)
    expect(desktop!.onNotificationClickedCalls[0]).toBe(cb)
    expect(desktop!.removeListenerCalls).toBe(0)

    unsubscribe()
    expect(desktop!.removeListenerCalls).toBe(1)
  })
})

describe('chat-notifier.web — desktop attention', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('asks the desktop shell for attention with this device’s settings for a DM', async () => {
    const calls: any[] = []
    installEnv({ document: makeFakeDocument(), desktop: { isDesktop: true } })
    ;((globalThis as any).window.shogoDesktop as any).requestAttention = async (args: any) => {
      calls.push(args)
      return { ok: true, attention: true }
    }
    const mod = await freshModule()
    await mod.requestAttention('dm')
    expect(calls).toEqual([{ dockBounce: 'once', flashTaskbar: true }])
  })

  test('ignores reasons that do not ask for attention, and does nothing in a browser', async () => {
    const calls: any[] = []
    installEnv({ document: makeFakeDocument(), desktop: { isDesktop: true } })
    ;((globalThis as any).window.shogoDesktop as any).requestAttention = async (args: any) => {
      calls.push(args)
      return { ok: true }
    }
    const mod = await freshModule()
    await mod.requestAttention('keyword')
    expect(calls).toHaveLength(0)

    installEnv({ document: makeFakeDocument() })
    const browser = await freshModule()
    await expect(browser.requestAttention('dm')).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe('chat-notifier.web — channel alert sound', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('a channel alert whose cue already played is silent, otherwise the OS sound is left alone', async () => {
    installEnv({ document: makeFakeDocument(), withNotification: true, initialPermission: 'granted' })
    const mod = await freshModule()
    await mod.notifyChannelMessage({
      conversationId: 'c1', messageId: 'm1', threadRootId: null, title: 'ada', body: 'hi', silent: true,
    })
    await mod.notifyChannelMessage({
      conversationId: 'c2', messageId: 'm2', threadRootId: null, title: 'bo', body: 'yo',
    })
    const Ctor = (globalThis as any).Notification as FakeNotificationCtor
    expect(Ctor.instances[0].options.silent).toBe(true)
    expect(Ctor.instances[1].options.silent).toBe(false)
  })
})
