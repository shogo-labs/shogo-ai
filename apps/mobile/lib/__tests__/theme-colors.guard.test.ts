// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Source guard: colour must come from the theme, not from a literal (SHO-544).
 *
 * The app's appearance settings (light/dark/system + an accent preset) reach
 * components as CSS vars — `--color-primary`, `--color-primary-foreground`,
 * `--color-muted-foreground`, `--color-destructive`, `--color-brand-landing` —
 * which is what `bg-primary` / `text-muted-foreground` and the themed
 * `<Spinner tone>` resolve to. A hex literal does not move with them, so:
 *
 * - react-native's `ActivityIndicator` renders react-native-web's `#1976D2`
 *   unless a colour is passed, which is why 389 of them were blue whatever the
 *   accent was;
 * - Shogo-orange (`#e27927`, `#f97316`) and the marketplace blues ignored the
 *   accent entirely;
 * - one grey (`#71717a`, `#a1a1aa`, `#6b7280`, `#888`) served both modes;
 * - `bg-brand-landing` is the marketing accent and must not reach app chrome
 *   (signed-in surfaces), only the auth/marketing screens.
 *
 * A literal is only acceptable where the colour cannot come from the theme —
 * third-party brands, user-picked swatches, data-viz series, Monaco/xterm
 * themes. Those files are listed below with the reason, so adding one is a
 * deliberate act with a paper trail rather than a silent leak.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const repoRoot = resolve(root, '../..')

const SCAN_DIRS = [
  resolve(root, 'app'),
  resolve(root, 'components'),
  resolve(repoRoot, 'packages/shared-ui/src'),
]

/**
 * Files allowed to name a brand / status / neutral colour literally, each for
 * a reason that does not expire. Keys are repo-relative paths.
 */
const LITERAL_ALLOW_LIST: Record<string, string> = {
  // --- marketing / auth surfaces: these are the brand, not app chrome ---
  'packages/shared-ui/src/screens/LoginScreen.tsx': 'sign-in surface keeps the landing accent',
  'packages/shared-ui/src/screens/EmailVerificationScreen.tsx': 'sign-up surface keeps the landing accent',
  'packages/shared-ui/src/screens/ProjectListScreen.tsx': 'first-run surface before any workspace theme exists',
  'packages/shared-ui/src/screens/InstancePickerPopover.tsx': 'rendered inside the sign-in surface',
  'packages/shared-ui/src/primitives/Button.tsx': "the `brand` variant is the landing accent by definition",
  'packages/shared-ui/src/tokens/brand.ts': 'the landing brand tokens themselves',
  'apps/mobile/app/(auth)/reset-password.tsx': 'auth surface, matches the sign-in screen',
  'apps/mobile/app/auth/local-link.tsx': 'auth surface, matches the sign-in screen',
  'apps/mobile/app/auth/chat-link.tsx': 'auth surface, matches the sign-in screen',
  'apps/mobile/app/auth/slack-link.tsx': 'auth surface, matches the sign-in screen',
  'apps/mobile/app/auth/cli-link.tsx': 'auth surface, matches the sign-in screen',
  'apps/mobile/app/invite/[token].tsx': 'invitation landing before sign-in',
  'apps/mobile/app/invitations/[id]/accept.tsx': 'invitation landing before sign-in',
  'apps/mobile/app/r/[code].tsx': 'public referral landing before sign-in',

  // --- fixed surfaces: deliberately one palette in both modes ---
  'apps/mobile/components/RootErrorBoundary.tsx':
    'last-resort screen renders when the theme providers are what failed',
  'apps/mobile/components/island/buddy/BuddyCustomizer.tsx': 'buddy look swatches, not app colour',
  'apps/mobile/components/team-chat/HuddleStageView.tsx': 'video stage is always a black surface',
  'apps/mobile/components/team-chat/HuddleWindow.tsx': 'video window is always a black surface',
  'apps/mobile/components/team-chat/VideoAttachment.tsx': 'video thumbnails are always a black surface',
  'apps/mobile/components/chat/NativeVideoView.tsx': 'video player chrome is always a black surface',
  'apps/mobile/components/whats-new/WhatsNewModal.tsx': 'modal artwork keeps its own palette',
  'apps/mobile/components/analytics/StackedAreaChart.tsx': 'chart series colours, not UI colour',
  'apps/mobile/components/analytics/ContentAnalytics.tsx': 'chart series colours, not UI colour',
  'apps/mobile/components/meetings/MeetingTranscript.tsx': 'per-speaker palette, not UI colour',
  'apps/mobile/components/project/panels/ChannelsPanel.tsx': 'third-party brand swatches (WhatsApp, Telegram, Slack)',
  'apps/mobile/components/canvas/canvas-themes.ts': 'user-selectable canvas themes',
  'apps/mobile/components/canvas/CanvasThemePicker.tsx': 'previews user-selectable canvas themes',
}

/** Why the accent must not be named as a hex literal. */
const BRAND_AND_ACCENT_LITERALS = [
  '#e27927',
  '#f97316',
  '#fb923c',
  '#2563eb',
  '#3b82f6',
  '#60a5fa',
  '#1976d2',
]

/** Why one grey cannot serve both light and dark. */
const NEUTRAL_LITERALS = ['#71717a', '#a1a1aa', '#6b7280', '#888']

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

/** Every scanned file that is not explicitly allow-listed. */
const guardedFiles = SCAN_DIRS.flatMap(sourceFiles)
  .map((file) => ({ file, repoPath: relative(repoRoot, file) }))
  .filter(({ repoPath }) => !(repoPath in LITERAL_ALLOW_LIST))
  .map(({ file, repoPath }) => ({ file, repoPath, source: stripComments(readFileSync(file, 'utf8')) }))

describe('theme colour guard (SHO-544)', () => {
  test('nothing renders react-native ActivityIndicator except the spinner primitive', () => {
    const offenders = guardedFiles
      .filter(
        ({ repoPath }) =>
          repoPath !== 'apps/mobile/components/ui/spinner/index.tsx' &&
          repoPath !== 'packages/shared-ui/src/primitives/Spinner.tsx',
      )
      .filter(({ source }) => /import[^;]*\bActivityIndicator\b[^;]*from\s*['"]react-native['"]/.test(source))
      .map(({ repoPath }) => repoPath)
    expect(offenders).toEqual([])
  })

  test('the spinner never hardcodes its colour', () => {
    const offenders = guardedFiles
      .filter(({ source }) => /<Spinner\b[^>]*\bcolor=/.test(source))
      .map(({ repoPath }) => repoPath)
    expect(offenders).toEqual([])
  })

  test('the marketing accent stays out of app chrome', () => {
    const offenders = guardedFiles
      .filter(({ source }) => /\b(bg|text|border|from|to|via)-brand-landing\b/.test(source))
      .map(({ repoPath }) => repoPath)
    expect(offenders).toEqual([])
  })

  test('no accent, brand or neutral colour is named as a literal', () => {
    const literals = [...BRAND_AND_ACCENT_LITERALS, ...NEUTRAL_LITERALS]
    const pattern = new RegExp(
      `(?<![A-Za-z])color=["'](?:${literals.join('|')})["']` +
        `|((?:bg|text|border|fill|stroke)-\\[(?:${literals.join('|')})\\])`,
      'i',
    )
    const offenders = guardedFiles
      .filter(({ source }) => pattern.test(source))
      .map(({ repoPath }) => repoPath)
    expect(offenders).toEqual([])
  })

  test('the allow-list only names files that still exist', () => {
    const files = new Set(SCAN_DIRS.flatMap(sourceFiles).map((file) => relative(repoRoot, file)))
    const missing = Object.keys(LITERAL_ALLOW_LIST).filter((path) => !files.has(path))
    expect(missing).toEqual([])
  })

  test('the spinner primitive is theme-token driven', () => {
    const spinner = readFileSync(resolve(root, 'components/ui/spinner/index.tsx'), 'utf8')
    expect(spinner).toContain('@shogo/shared-ui/spinner')
    const primitive = readFileSync(
      resolve(repoRoot, 'packages/shared-ui/src/primitives/Spinner.tsx'),
      'utf8',
    )
    expect(primitive).toContain('nativeStyleToProp')
    for (const tone of ['primary', 'primary-foreground', 'muted-foreground', 'destructive']) {
      expect(primitive).toContain(`text-${tone}`)
    }
  })
})
