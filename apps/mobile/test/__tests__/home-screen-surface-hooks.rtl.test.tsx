// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The home screen must keep the same hook count across every surface it can
 * render (SHO-185, round 4).
 *
 * `/` lands on the workspace agent, `/(app)/home` on the team feed, and a
 * workspace whose runtime is off on the builder. All three live in one
 * component, and the two early returns used to sit *above* the machine-composer
 * hooks (`useActiveInstance`, `useCallback`, `useMachineWorkspace`) — so the
 * moment `homeSurface` flipped while the workspace loaded, React threw
 * "Rendered more hooks than during the previous render" and RootErrorBoundary
 * blanked the whole app. `E2E (task restart)` failed on exactly that.
 *
 * RTL never caught it because nothing re-rendered those branches: every other
 * screen test mounts one surface and asserts on it. This one flips them.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../react-native-mock'

const state = {
  runtimeEnabled: true,
  kind: 'team' as string | null,
}

const View = 'div'
const passthrough = (testID?: string) =>
  function Passthrough() {
    return createElement('div', { 'data-testid': testID })
  }

mock.module('react-native', () =>
  createReactNativeMock({
    // `ios` makes the agent surface `narrow`, which is what the feed needs;
    // the default 1024x768 viewport keeps `isNativePhone` false so the mount
    // effect skips its Animated.timing.
    Platform: { OS: 'ios' },
  }),
)
// `@shogo/shared-ui` resolves react-native from the workspace root, outside the
// surface `test/testing-library.ts` stubs, so the real package drags the Flow
// build into happty-dom. Everything this screen touches is a passthrough here.
mock.module('@shogo/shared-ui/primitives', () => {
  const host = (tag = 'div') =>
    function Host({ children }: { children?: unknown }) {
      return createElement(tag, null, children as never)
    }
  return {
    Button: host('button'),
    Input: host('input'),
    Badge: host('span'),
    Avatar: host('span'),
    Separator: host('div'),
    Switch: host('button'),
    Progress: host('div'),
    Skeleton: host('div'),
    Alert: host('div'),
    AlertTitle: host('div'),
    AlertDescription: host('div'),
    Checkbox: host('input'),
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  }
})
mock.module('../../components/branding/ShogoLogoMark', () => ({
  ShogoLogoMark: passthrough('shogo-logo-mark'),
}))

mock.module('expo-router', () => ({
  useRouter: () => ({ push() {}, replace() {}, navigate() {}, back() {} }),
}))
mock.module('expo-linear-gradient', () => ({ LinearGradient: View }))
mock.module('react-native-safe-area-context', () => ({
  SafeAreaView: View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

// `observer` memoises the screen: two renders with an empty props object are
// shallow-equal and React skips the body entirely, which would hide the very
// re-render this test is about. The hook order is what is under test, so the
// component runs plain here.
mock.module('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
mock.module('../../contexts/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com' }, isAuthenticated: true }),
}))
mock.module('../../contexts/posthog', () => ({ usePostHogSafe: () => ({ capture() {} }) }))
mock.module('../../contexts/theme', () => ({ useResolvedTheme: () => 'light' }))
mock.module('../../contexts/active-instance', () => ({
  useActiveInstance: () => ({ instance: null }),
}))
mock.module('../../contexts/domain', () => {
  const store = { all: [], loadAll: async () => [], get: () => null, loadById: async () => null }
  const noop = async () => null
  return {
    useProjectCollection: () => store,
    useWorkspaceCollection: () => store,
    useMemberCollection: () => store,
    useChatSessionCollection: () => store,
    useDomainHttp: () => ({ get: async () => ({ data: {} }) }),
    useDomainActions: () => ({
      createProject: noop,
      updateProject: noop,
      createChatSession: noop,
      updateChatSession: noop,
      installListing: noop,
    }),
  }
})
mock.module('../../components/layout/MobileWorkspaceChromeContext', () => ({
  useMobileWorkspaceChrome: () => true,
}))
mock.module('../../lib/platform-config', () => ({
  usePlatformConfig: () => ({ localMode: false, features: {} }),
  isWorkspaceRuntimeEnabled: () => state.runtimeEnabled,
  isProjectWorkspaceRuntimeEnabled: () => state.runtimeEnabled,
  isLocalMode: () => false,
  invalidatePlatformConfigCache: () => {},
}))
mock.module('../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'ws-1' }),
}))
mock.module('../../hooks/useWorkspaceInView', () => ({
  useWorkspaceInView: () => ({ id: 'ws-1' }),
}))
mock.module('../../hooks/useWorkspaceExperience', () => ({
  useWorkspaceExperience: () => ({ resolved: true, kind: state.kind, composer: 'agent' }),
}))
mock.module('@shogo/shared-app/hooks', () => ({
  useBillingData: () => ({ hasAdvancedModelAccess: false }),
}))

mock.module('../../components/chat/ChatInput', () => ({
  DEFAULT_MODEL: 'auto',
  ChatInput: ({ inputTestID }: { inputTestID?: string }) => passthrough(inputTestID ?? 'chat-input')(),
}))
mock.module('../../components/workspace/WorkspaceAgentChatScreen', () => ({
  WorkspaceAgentChatScreen: passthrough('workspace-agent-chat'),
}))
mock.module('../../components/home/MobileHomeFeed', () => ({
  MobileHomeFeed: passthrough('mobile-home-feed'),
}))
mock.module('../../components/personal/CreatePersonalSpaceBanner', () => ({
  CreatePersonalSpaceBanner: () => null,
}))
mock.module('../../components/project/ProjectSourceMenu', () => ({
  ProjectSourceMenu: () => null,
}))
mock.module('../../components/chat/TechStackPicker', () => ({ TechStackPicker: () => null }))
mock.module('../../components/chat/ComposerPlusMenu', () => ({ ComposerPlusSection: () => null }))

mock.module('../../lib/api', () => ({ api: {}, getOnboardingMessage: () => null }))
mock.module('../../lib/analytics', () => ({ EVENTS: {}, trackEvent: () => {} }))
mock.module('../../lib/pending-license', () => ({
  getPendingLicenseCode: () => null,
  clearPendingLicenseCode: () => {},
}))
mock.module('../../lib/interaction-mode-preference', () => ({
  loadInteractionModePreference: async () => null,
  saveInteractionModePreference: async () => {},
}))
mock.module('../../lib/agent-mode-preference', () => ({
  loadModelPreference: async () => null,
  saveModelPreference: async () => {},
}))
mock.module('../../lib/visible-models', () => ({ useReconcileStaleModelSelection: () => {} }))
mock.module('../../lib/pending-image-store', () => ({ setPendingFiles: () => {} }))
// Its module scope builds an Animated easing curve; the composer pad is not what
// this test is about, so the hook is a constant.
mock.module('../../lib/use-native-composer-keyboard', () => ({ useNativeComposerDockPad: () => 0 }))

const { HomeScreen } = await import('../../app/(app)/index')

beforeEach(() => {
  state.runtimeEnabled = true
  state.kind = 'team'
})

afterEach(() => {
  state.runtimeEnabled = true
  state.kind = 'team'
})

describe('the home screen across surfaces', () => {
  test('flipping builder → agent → feed → builder keeps the hook count stable', () => {
    const { rerender } = render(createElement(HomeScreen, { forceBuilder: true }))
    expect(screen.getByTestId('home-composer-input')).toBeTruthy()

    // The landing: the workspace agent, an early return.
    rerender(createElement(HomeScreen, {}))
    expect(screen.getByTestId('workspace-agent-chat')).toBeTruthy()

    // `/(app)/home` on a narrow team workspace: the feed, the other early return.
    rerender(createElement(HomeScreen, { explicitHome: true }))
    expect(screen.getByTestId('mobile-home-feed')).toBeTruthy()

    // …and back to a surface that renders the composer and its machine hooks.
    rerender(createElement(HomeScreen, { forceBuilder: true }))
    expect(screen.getByTestId('home-composer-input')).toBeTruthy()
  })

  test('turning the workspace runtime off drops back to the builder without throwing', () => {
    const { rerender } = render(createElement(HomeScreen, {}))
    expect(screen.getByTestId('workspace-agent-chat')).toBeTruthy()

    state.runtimeEnabled = false
    rerender(createElement(HomeScreen, {}))
    expect(screen.getByTestId('home-composer-input')).toBeTruthy()
  })
})
