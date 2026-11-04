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
    const effect = screen.slice(screen.indexOf('const applyBoot = (record'))
    const noKey = effect.slice(
      effect.indexOf('if (!bootKey)'),
      effect.indexOf('const cached = peekWorkspaceChatBoot'),
    )
    expect(noKey).toContain('bootWaitCanEndWithoutRecord({')
    expect(noKey).not.toMatch(/workspaces\?\.all != null\) setBootPending\(false\)/)
  })

  test('a successful load answers the next open', () => {
    expect(screen).toContain('rememberWorkspaceChatBoot<PersonalAgentProfile>(bootKey, {')
  })
})
