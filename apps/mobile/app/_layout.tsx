// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { mark as csMark } from '../lib/cold-start-timing'
csMark('root:layout:module-load')
import '../polyfills'
import '../lib/monaco-cancellation-silencer'
csMark('root:layout:after-polyfills')
import '../lib/devtools'
import '../global.css'
csMark('root:layout:after-global-css')
import '../lib/icon-interop'

import { useEffect } from 'react'
import { Platform } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme } from 'react-native'
import * as Sentry from '@sentry/react-native'

// Per-platform Sentry DSNs. Each native binary / web bundle only ever has
// one of these populated (Metro inlines `process.env.EXPO_PUBLIC_*` at
// bundle time, and the workflows only set the relevant one), so this is
// effectively a compile-time switch — the others resolve to `undefined`.
//
//   ios          -> shogo-ios     (set by .github/workflows/ios.yml)
//   android      -> shogo-android (set by .github/workflows/android.yml)
//   web (mobile) -> javascript-react (set by apps/mobile/Dockerfile via deploy.yml)
//   web (desktop renderer) -> shogo-desktop (set by desktop-release-*.yml,
//                              sourced from SHOGO_DESKTOP_SENTRY_DSN)
const rawSentryDsn = Platform.select({
  ios: process.env.EXPO_PUBLIC_SENTRY_DSN_IOS,
  android: process.env.EXPO_PUBLIC_SENTRY_DSN_ANDROID,
  default: process.env.EXPO_PUBLIC_SENTRY_DSN_WEB,
})

// Metro inlines `process.env.EXPO_PUBLIC_*` at bundle time, so whatever value
// lives in the CI secret (or a developer's shell) is frozen into the JS for
// the lifetime of that build. If the secret is ever a placeholder like `-`,
// `disabled`, or stray whitespace, the React-Native Sentry SDK rejects it at
// init time with `Invalid Sentry Dsn` and lands in an unhealthy state for the
// rest of the session. Accept only values that parse as the DSN shape
// `@sentry/*` actually expects (`https://<publicKey>@<host>/<projectId>`);
// everything else is treated as "Sentry disabled".
function isValidSentryDsn(value: string | undefined): value is string {
  if (!value) return false
  try {
    const u = new URL(value)
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      !!u.hostname &&
      !!u.username &&
      u.pathname !== '' &&
      u.pathname !== '/'
    )
  } catch {
    return false
  }
}

const sentryDsn = isValidSentryDsn(rawSentryDsn) ? rawSentryDsn : undefined

if (rawSentryDsn && !sentryDsn && __DEV__) {
  console.warn(
    `[sentry] Ignoring malformed DSN (${JSON.stringify(rawSentryDsn)}); Sentry disabled.`,
  )
}
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { AuthProvider } from '../contexts/auth'
import { ActiveInstanceProvider } from '../contexts/active-instance'
import { InstanceOfflineWatcher } from '../components/instance/InstanceOfflineWatcher'
import { PostHogProvider } from '../contexts/posthog'
import { ThemeProvider, useTheme } from '../contexts/theme'
import { AccentThemeProvider } from '../contexts/accent-theme'
import { RootErrorBoundary } from '../components/RootErrorBoundary'
import { UpdateBanner } from '../components/UpdateBanner'
import { captureAttribution } from '../lib/attribution'
import { safeSetItem } from '../lib/safe-storage'
import { setPendingLicenseCode } from '../lib/pending-license'
import * as ExpoLinking from 'expo-linking'

type SentryBeforeSend = NonNullable<Parameters<typeof Sentry.init>[0]>['beforeSend']
type SentryErrorEvent = Parameters<NonNullable<SentryBeforeSend>>[0]

/**
 * production_web noise filter. These high-volume issues are environmental,
 * not Shogo code defects — left unfiltered they bury real regressions in
 * the dashboard and burn quota. Each branch maps to a specific issue
 * confirmed during Sentry triage (see the triage plan, Tier 2).
 */
function isNoiseEvent(event: SentryErrorEvent): boolean {
  const values = event.exception?.values ?? []
  const messages = values
    .map((v) => `${v.type ?? ''}: ${v.value ?? ''}`)
    .concat(typeof event.message === 'string' ? [event.message] : [])
  const frames = values.flatMap((v) => v.stacktrace?.frames ?? [])
  const reqUrl = typeof event.request?.url === 'string' ? event.request.url : ''

  // 1. Preview-iframe failures (top issue by volume). The sandboxed preview
  //    app injects `frame_ant.js`, which fetches its own origin
  //    (<uuid>.preview.shogo.ai). While the preview is booting / being torn
  //    down those reject with "Failed to fetch" — surfaced here but owned by
  //    the preview runtime, not studio.
  const PREVIEW_HOST_RE = /(?:preview--[^.\s/]+|[^.\s/]+\.preview)\.shogo\.ai/i
  const isPreviewIframe =
    frames.some((f) => (f.filename ?? '').includes('frame_ant')) ||
    messages.some((m) => PREVIEW_HOST_RE.test(m)) ||
    PREVIEW_HOST_RE.test(reqUrl)
  if (isPreviewIframe) return true

  // 2. Transient backend availability / network — server health, not a
  //    client bug. The SDK surfaces 5xx as ShogoError; `AbortSignal.timeout`
  //    surfaces as TimeoutError; dropped/blocked connections as
  //    "Failed to fetch" / "Load failed" / "NetworkError".
  const isTransientBackend = messages.some(
    (m) =>
      /Request failed with status 50[234]\b/.test(m) ||
      /\bTimeoutError\b/.test(m) ||
      /signal timed out/i.test(m) ||
      /Failed to fetch\b/.test(m) ||
      /\bLoad failed\b/.test(m) ||
      /NetworkError when attempting to fetch/i.test(m),
  )
  if (isTransientBackend) return true

  // 3. Browser-extension DOM races (e.g. Google Translate mutates the
  //    React-owned DOM, then React's insertBefore/removeChild can't find the
  //    node). Not reproducible in-app and unfixable from our side.
  const isExtensionDomRace = messages.some(
    (m) =>
      /Failed to execute '(insertBefore|removeChild)' on 'Node'/.test(m) &&
      /not a child of this node|node to be removed is not a child/.test(m),
  )
  if (isExtensionDomRace) return true

  return false
}

Sentry.init({
  dsn: sentryDsn,
  environment: process.env.EXPO_PUBLIC_APP_ENV || 'development',
  release: process.env.EXPO_PUBLIC_BUILD_HASH || 'dev',
  tracesSampleRate: 0.2,
  enabled: !!sentryDsn,
  // Web symbolication fix. `@sentry/react-native` installs a `RewriteFrames`
  // integration that rewrites every frame's filename to `app:///<file>` — a
  // native-bundle convention (Hermes / `index.android.bundle`) that is
  // meaningless on web. On web it actively breaks symbolication: the Metro
  // serializer injects Debug IDs into `globalThis._sentryDebugIds` keyed by the
  // *real* bundle URL (`https://…/_expo/static/js/web/index-<hash>.js`), and
  // core's `applyDebugIds` matches those against each frame's filename to build
  // `event.debug_meta`. Once RewriteFrames has changed the filenames to
  // `app:///index-<hash>.js`, that match fails and events ship with
  // `debug_meta.images: []` → Sentry has no Debug ID to look up the uploaded
  // source maps, so production_web stacks stay minified. Dropping the rewrite
  // on web keeps frame filenames aligned with the injected Debug IDs; native
  // builds keep the integration (they need `app:///`).
  integrations: (defaultIntegrations) =>
    Platform.OS === 'web'
      ? defaultIntegrations.filter((i) => i.name !== 'RewriteFrames')
      : defaultIntegrations,
  // Drop unhandled promise rejections whose "reason" was a non-Error value
  // (e.g. `Promise.reject(new Event(...))` from third-party libs, or string
  // rejections from Stripe / posthog). They show up in Sentry as a single
  // empty `<unknown>` issue with no stack trace, no breadcrumbs that we
  // can act on, and just inflate the issue count. If a real bug ever
  // rejects with a non-Error, we'll still see breadcrumbs / network in
  // adjacent issues.
  beforeSend(event, hint) {
    // Drop high-volume non-actionable noise (preview iframe, transient
    // backend/network, browser-extension DOM races). See triage plan Tier 2.
    if (isNoiseEvent(event)) return null

    const reason = hint?.originalException as unknown
    const isPlainEventReason =
      typeof reason !== 'undefined' &&
      reason !== null &&
      !(reason instanceof Error) &&
      typeof (reason as { stack?: unknown }).stack !== 'string'
    const hasUsableStack = !!event.exception?.values?.some(
      (v) => (v.stacktrace?.frames?.length ?? 0) > 0,
    )
    if (isPlainEventReason && !hasUsableStack) return null
    return event
  },
})

const PENDING_TEMPLATE_KEY = 'pending_template_id'
const PENDING_APP_TEMPLATE_KEY = 'pending_app_template'

function useCaptureTemplateDeepLink() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const templateId = params.get('template')
    if (templateId) {
      safeSetItem(PENDING_TEMPLATE_KEY, templateId)
      params.delete('template')
    }
    const appTemplateName = params.get('app_template')
    if (appTemplateName) {
      safeSetItem(PENDING_APP_TEMPLATE_KEY, appTemplateName)
      params.delete('app_template')
    }
    if (templateId || appTemplateName) {
      const qs = params.toString()
      const clean = window.location.pathname + (qs ? `?${qs}` : '')
      window.history.replaceState({}, '', clean)
    }
  }, [])
}

// Capture a non-iOS license-key redeem code before the (app) auth guard can
// redirect an unauthenticated user to sign-in. iOS upgrades must use App Store
// In-App Purchase only.
function useCaptureRedeemDeepLink() {
  const nativeUrl = ExpoLinking.useURL()
  useEffect(() => {
    if (Platform.OS === 'ios') return
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return
      const params = new URLSearchParams(window.location.search)
      const code = params.get('redeem')
      // Leave the param in place so the billing screen's own
      // useLocalSearchParams read keeps working for signed-in direct
      // visits; we only mirror it into storage as a signup-detour backup.
      if (code) setPendingLicenseCode(code)
      return
    }
    if (!nativeUrl) return
    const code = ExpoLinking.parse(nativeUrl).queryParams?.redeem
    if (typeof code === 'string' && code) setPendingLicenseCode(code)
  }, [nativeUrl])
}

function RootLayoutInner() {
  csMark('root:layout:render')
  useEffect(() => { csMark('root:layout:mounted') }, [])
  useEffect(() => { captureAttribution() }, [])
  useCaptureTemplateDeepLink()
  useCaptureRedeemDeepLink()
  const systemColorScheme = useColorScheme()
  const { theme, isLoaded } = useTheme()

  const statusBarScheme = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme

  if (!isLoaded) return null

  return (
    <GluestackUIProvider mode={theme}>
      <PostHogProvider>
        <AuthProvider>
          <ActiveInstanceProvider>
            <InstanceOfflineWatcher />
            <UpdateBanner />
            <StatusBar style={statusBarScheme === 'dark' ? 'light' : 'dark'} />
            <Stack screenOptions={{ headerShown: false, lazy: true }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="invite/[token]" />
              <Stack.Screen name="(onboarding)" />
              <Stack.Screen name="(app)" />
              <Stack.Screen name="(admin)" />
            </Stack>
          </ActiveInstanceProvider>
        </AuthProvider>
      </PostHogProvider>
    </GluestackUIProvider>
  )
}

function RootLayout() {
  return (
    <RootErrorBoundary>
      <ThemeProvider>
        <AccentThemeProvider>
          <RootLayoutInner />
        </AccentThemeProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  )
}

export default Sentry.wrap(RootLayout)
