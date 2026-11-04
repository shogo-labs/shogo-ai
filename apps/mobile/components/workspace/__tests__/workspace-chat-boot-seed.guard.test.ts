// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The chat panel and the workspace agent screen paint from the device on their
 * FIRST frame (SHO-309).
 *
 * The behaviour itself is driven by `lib/chat-device-boot` (unit-tested) and
 * end to end by `e2e/local/chat-history-cache.test.ts`. What this holds is the
 * wiring, because it is the part that silently regresses: an initial state that
 * starts empty, a `useChat` that starts from nothing, or a loader that runs
 * while the device read is still in flight all put the loader back on screen
 * without failing any test that only looks at the network.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const MOBILE = join(import.meta.dir, '../../..')
const read = (relative: string) => readFileSync(join(MOBILE, relative), 'utf8')

describe('the panel opens from the device', () => {
  const panel = read('components/chat/ChatPanel.tsx')

  test('the first frame is seeded, not empty', () => {
    // Memoized so the seed object is stable across renders — an unmemoized
    // seed would be a new object every render and re-seed `useChat`.
    expect(panel).toMatch(
      /const firstPaintSeed = useMemo\(\s*\(\) => seedTranscript\(/,
    )
    expect(panel).toContain(
      'const cachedMessagesRef = useRef<any[] | null>(firstPaintSeed.messages)',
    )
    // `useChat` starts from the same transcript, so the SDK does not paint an
    // empty list under a loader.
    expect(panel).toMatch(/const \{\s*messages,[\s\S]{0,400}?\} = useChat\(\{[\s\S]{0,600}?messages: \(cachedMessagesRef\.current as UIMessage\[\] \| null\) \?\? undefined/)
  })

  test('a chat the device already holds is complete on mount', () => {
    expect(panel).toMatch(
      /useState\(\(\) => \{[\s\S]{0,400}?seedTranscript\(currentSessionId, historyKeyFor\(currentSessionId\)\)/,
    )
  })

  test('a session switch seeds from the device mirror as well as memory', () => {
    const switchBlock = panel.slice(panel.indexOf('if (prevSessionIdRef.current !== currentSessionId) {'))
    expect(switchBlock.slice(0, 600)).toContain('seedTranscript(')
  })

  test('the loader is gated on the device read, not shown while it is pending', () => {
    const loader = panel.lastIndexOf('Loading conversation...')
    const gate = panel.lastIndexOf('transcriptLoaderVisible({', loader)
    expect(gate).toBeGreaterThan(-1)
    expect(panel.slice(gate, loader)).toContain('hydrationPending:')
  })

  test('the delta path is seeded from the same mirror the paint used', () => {
    expect(panel).toContain('const peeked = peekChatHistory("project", key)')
  })

  test('the loader is decided during render, not by an effect', () => {
    // CI caught one "Loading conversation..." frame on a reload: the pending
    // flag was filled inside the hydration effect, i.e. after the first paint,
    // so the frame that needed to wait read "nothing pending". The render reads
    // the settled set instead, which is only true once the device answered.
    const loader = panel.lastIndexOf('Loading conversation...')
    const gate = panel.lastIndexOf('hydrationPending:', loader)
    expect(gate).toBeGreaterThan(-1)
    expect(panel.slice(gate, loader)).toContain(
      '!historyHydrationSettledRef.current.has(historyStoreKey)',
    )
    // …and every path that will not paint a device answer settles the key.
    expect(panel).toContain('historyHydrationSettledRef.current.add(key)')
  })
})

describe('the workspace agent screen opens from the device', () => {
  const screen = read('components/workspace/WorkspaceAgentChatScreen.tsx')

  test('the session and profile are seeded from the boot record', () => {
    expect(screen).toMatch(
      /useState<PersonalAgentProfile \| null>\(\s*\(\) => peekWorkspaceChatBoot<PersonalAgentProfile>\(bootKey\)\?\.profile \?\? null,?\s*\)/,
    )
    expect(screen).toContain('return peekWorkspaceChatBoot<PersonalAgentProfile>(bootKey)?.sessionId ?? null')
  })

  test('a re-run of the load for the same workspace does not blank the chat', () => {
    const load = screen.slice(screen.indexOf('const loadWorkspaceChat = useCallback'))
    const reset = load.indexOf('if (shownWorkspace.current !== workspace.id) {')
    expect(reset).toBeGreaterThan(-1)
    // The unconditional reset that used to unmount the panel is gone.
    const beforeReset = load.slice(load.indexOf('      try {'), reset)
    expect(beforeReset).not.toContain('setProfile(null)')
  })

  test('the spinner is only for a first-ever open', () => {
    expect(screen).toContain('workspaceChatLoadingView({')
    expect(screen).toContain('bootPending,')
    // The loader is one branch of that decision, never the fallback.
    const render = screen.slice(screen.indexOf('loadingView === "error"'))
    expect(render).toContain('loadingView === "spinner"')
  })

  test('the wait starts before the key exists, not after', () => {
    // This screen remounts on every reopen, and `bootKey` needs the signed-in
    // user and the workspace in view — both unset on its first frame. Deriving
    // `bootPending` from the key made that frame "not pending", so the spinner
    // covered a chat the device already had (SHO-309, caught in CI).
    expect(screen).toContain('const [bootPending, setBootPending] = useState(true)')
    expect(screen).not.toMatch(/useState\(\s*\(\) => !!bootKey/)
  })

  test('a record that arrives after the first frame still fills the screen', () => {
    // Same reason: the state initialisers above ran with no key, so a peek hit
    // in the effect must apply the record instead of only clearing `pending`.
    const effect = screen.slice(screen.indexOf('const applyBoot = (record'))
    const peekHit = effect.slice(
      effect.indexOf('const cached = peekWorkspaceChatBoot'),
      effect.indexOf('setBootPending(true)'),
    )
    expect(peekHit).toContain('applyBoot(cached)')
  })

  test('a missing key alone never ends the wait', () => {
    // CI caught the wait being released on the key being null: the workspace
    // collection was already loaded, but the workspace in view was not resolved
    // (or was refreshing), so the screen painted the spinner over a chat the
    // device held. Only an account with no workspaces may end it.
    const release = screen.slice(screen.indexOf('if (bootWaitCanEndWithoutRecord'))
    expect(release).toContain('collectionReady')
    expect(release).toContain('workspaceCount')
    expect(screen).not.toMatch(/workspaces\?\.all != null\) setBootPending\(false\)/)
  })

  test('a collection refresh cannot cancel the device read', () => {
    // CI's next failure: the first-ever open painted no loader at all, then
    // jumped straight to the chat. `WorkspaceCollection.all` is
    // `Array.from(self.items.values())` — a new array on every access — so
    // keying the read on it restarted (and cancelled) the read on every render,
    // and `bootPending` never cleared. The read keys on the boot key alone; the
    // collection's state reaches the "no workspaces" rule as primitives.
    expect(screen).toContain(
      'const workspaceCount = workspaces?.all?.length ?? 0',
    )
    const read = screen.slice(
      screen.indexOf('const applyBoot = (record'),
      screen.indexOf('const loadWorkspaceChat = useCallback'),
    )
    expect(read).toContain('}, [bootKey, initialSessionId, startNewSession])')
    expect(read).not.toContain('workspaces?.all]')
    expect(screen).toContain('}, [bootKey, collectionReady, workspaceCount])')
  })

  test('the workspace survives the collection being between answers', () => {
    // CI's next failure, and the one the video showed: on an in-app reopen the
    // whole screen remounted while `workspaces.loadAll()` was in flight, so
    // `useWorkspaceInView()` was null for the first frames — no id, no boot key,
    // no chat — and the chrome flipped to the team shell. The workspace must be
    // kept across that window (and seeded from the persisted selection when
    // this JS session has never resolved it).
    expect(screen).not.toMatch(/const workspace = useWorkspaceInView\(\)/)
    expect(screen).toContain('const inView = useWorkspaceInView()')
    expect(screen).toMatch(
      /workspaceInViewWhileLoading\(\s*inView,\s*lastInView\.current,\s*selectedWorkspaceId,/,
    )
    // Keyed on the persisted selection, so a switch still lands: the old
    // workspace is only kept while the person's selection is still that one.
    expect(screen).toContain('getCachedWorkspaceKind(selectedWorkspaceId)')
  })

  test('a successful load answers the next open', () => {
    expect(screen).toContain('rememberWorkspaceChatBoot<PersonalAgentProfile>(bootKey, {')
  })
})
