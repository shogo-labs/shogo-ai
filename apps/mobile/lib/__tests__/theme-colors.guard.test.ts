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
  'apps/mobile/components/project/panels/ide/terminal/XtermView.tsx': 'terminal emulator theme, not app colour',
  'apps/mobile/components/project/panels/ide/agentEditAnimation.ts': 'IDE edit-pulse colours drawn inside the editor',
  'apps/mobile/components/team-chat/HuddlePip.tsx': 'video pip is always a black surface',
  'apps/mobile/components/team-chat/HuddleVideo.tsx': 'video surface is always black',
  'apps/mobile/components/canvas/CanvasWebView.tsx':
    'the WebView loading/error overlay is canvas chrome with its own fixed palette',
  'apps/mobile/components/notifications/NotificationStack.tsx': 'toast cards are a fixed dark surface in both modes',
  'apps/mobile/components/chat/turns/MessageContent.tsx':
    "the outgoing ('me') bubble is a deliberate fixed dark surface with white text",
  'apps/mobile/components/settings/MemberUsageDetail.tsx': 'chart series colour, not UI colour',
  'apps/mobile/components/layout/MobileWorkspaceShell.tsx': 'black letterbox behind the shell',
  'apps/mobile/components/island/IslandIdle.tsx': 'island look is always a black surface',
  'apps/mobile/components/island/lab/BrandLab.tsx': 'brand lab renders the brand palette',
  'apps/mobile/components/island/buddy/webview-entry.ts': 'buddy look defaults',
  'apps/mobile/components/island/buddy/look.ts': 'buddy look palette',
  'apps/mobile/components/canvas/canvas-themes.ts': 'user-selectable canvas themes',
  'apps/mobile/components/canvas/CanvasThemePicker.tsx': 'previews user-selectable canvas themes',
  'apps/mobile/app/dev/island-demo.tsx': 'dev-only demo screen for the island look',
  'packages/shared-ui/src/branding/ShogoWordmark.tsx': 'the wordmark artwork itself',
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

/** Colour props React Native takes on a style object (or an SVG icon). */
const STYLE_COLOUR_PROPS = [
  'backgroundColor',
  'borderColor',
  'borderTopColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderRightColor',
  'color',
  'tintColor',
  'thumbColor',
  'trackColor',
  'placeholderTextColor',
  'selectionColor',
  'fill',
  'stroke',
]

/**
 * A hex or `rgb()` literal assigned to a colour prop. `shadowColor` is not in
 * the list on purpose: a shadow is black in every theme.
 */
const STYLE_LITERAL = new RegExp(
  `(?:^|[\\s,{])(?:${STYLE_COLOUR_PROPS.join('|')})\\s*:\\s*['"](#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\))['"]`,
  'g',
)

/**
 * A grey is mode-neutral enough to sit in a style (a translucent scrim, a
 * neutral border); a hue has to come from a token. Hexes always count, because
 * an opaque hex pins one mode.
 */
function hasHue(value: string): boolean {
  if (value.startsWith('#')) return true
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length < 3) return false
  return Math.max(...channels) - Math.min(...channels) > 12
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

  test('no style object pins a colour literally', () => {
    const offenders: string[] = []
    for (const { repoPath, source } of guardedFiles) {
      for (const match of source.matchAll(STYLE_LITERAL)) {
        if (hasHue(match[1])) offenders.push(`${repoPath}: ${match[0].trim()}`)
      }
    }
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
    // `nativeStyleToProp` is native-only, so the className alone leaves web on
    // react-native-web's #1976D2. Every tone needs a real colour for web too.
    expect(primitive).toContain('TONE_WEB_COLOR')
    expect(primitive).toContain("Platform.OS === 'web'")
    for (const token of [
      'rgb(var(--color-primary))',
      'rgb(var(--color-primary-foreground))',
      'rgb(var(--color-muted-foreground))',
      'rgb(var(--color-destructive))',
    ]) {
      expect(primitive).toContain(token)
    }
  })
})

/**
 * `className` on a bare `Animated.*` node is silently dropped unless that exact
 * component is registered with `cssInterop` (SHO-609).
 *
 * NativeWind only maps the class for components it knows: `react-native-css-interop`
 * registers `Text`, `View`, `Pressable`, … and `Animated.Text` / `Animated.View`
 * are different component objects, so the JSX runtime finds no entry for them and
 * the class never becomes a style. That is how "Planning next moves" went black
 * on the dark theme: SHO-544 removed the grey literal because `text-muted-foreground`
 * was assumed to colour the row, and nothing was rendering the label to notice.
 *
 * `apps/mobile/lib/animated-interop.ts` registers the primitives; this rule keeps
 * the next `Animated.*` + `className` site from relying on a class nobody applies.
 */
describe('animated component interop guard (SHO-609)', () => {
  const interopModule = resolve(root, 'lib/animated-interop.ts')
  const interopSource = readFileSync(interopModule, 'utf8')
  const appRoot = readFileSync(resolve(root, 'app/_layout.tsx'), 'utf8')

  /** `Animated.Text` → registered components, read off the registration module. */
  const registered = new Set(
    Array.from(interopSource.matchAll(/cssInterop\(\s*Animated\.(\w+)\s*,\s*\{\s*className/g)).map(
      (match) => match[1],
    ),
  )

  /**
   * Every `<Animated.X …>` tag in a file, with balanced braces and string
   * literals skipped so a `style={{ … }}` or an arrow prop cannot end the tag.
   */
  function animatedTags(source: string): { name: string; hasClassName: boolean }[] {
    const tags: { name: string; hasClassName: boolean }[] = []
    const opener = /<Animated\.(\w+)/g
    for (let match = opener.exec(source); match; match = opener.exec(source)) {
      let depth = 0
      let quote: string | null = null
      let end = match.index + match[0].length
      for (; end < source.length; end++) {
        const char = source[end]
        if (quote) {
          if (char === quote && source[end - 1] !== '\\') quote = null
          continue
        }
        if (char === '"' || char === "'" || char === '`') quote = char
        else if (char === '{') depth++
        else if (char === '}') depth--
        else if (char === '>' && depth === 0) break
      }
      const tag = source.slice(match.index, end)
      tags.push({ name: match[1], hasClassName: /\bclassName\s*=/.test(tag) })
    }
    return tags
  }

  test('the interop module is loaded by the app root', () => {
    expect(appRoot).toContain('import "../lib/animated-interop"')
  })

  test('the primitives the app animates with are the ones registered', () => {
    expect(registered.has('Text')).toBe(true)
    expect(registered.has('View')).toBe(true)
  })

  test('no Animated node carries a className its component never applies', () => {
    const offenders: string[] = []
    for (const { repoPath, source } of guardedFiles) {
      for (const tag of animatedTags(source)) {
        if (tag.hasClassName && !registered.has(tag.name)) {
          offenders.push(`${repoPath}: <Animated.${tag.name} className=…>`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('the shimmer label keeps the token class and a token colour for web', () => {
    const label = readFileSync(resolve(root, 'components/chat/turns/ShimmerLabel.tsx'), 'utf8')
    expect(label).toContain('text-muted-foreground')
    expect(label).toContain('rgb(var(--color-muted-foreground))')
    // A literal here is what SHO-544 removed; it must not come back.
    expect(label).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })
})
