// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The phone navigation standard, guarded (SHO-490).
 *
 * Every screen you push and every full-screen pane wears the DM's floating
 * glass header: `PhoneScreenHeader` (a 44px glass Back — or Close for a pane —
 * a glass title pill and glass trailing actions, over the content, with no bar
 * and no border). The screened idioms it retired are a hand-rolled back row
 * (`<ArrowLeft>` / a bare `accessibilityLabel="Back"` pressable) and a plain
 * back arrow.
 *
 * This test fails when a screen grows its own back row again. A file passes
 * when it renders `PhoneScreenHeader`, when it is one of the two files that
 * *are* the standard, or when it is on the allow-list below — each entry a
 * surface that is deliberately not a phone screen, with the reason. Keep that
 * list shrinking; never add to it for a phone screen.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MOBILE = join(import.meta.dir, '..', '..')
const ROOTS = ['app/(app)', 'components']

/** The one header, and the two controls it and the More tabs render through. */
const THE_STANDARD = [
  'components/layout/PhoneScreenHeader.tsx',
  'components/layout/PhoneBackButton.tsx',
]

/**
 * Surfaces that legitimately draw their own back control because they are not
 * phone screens: they are wide-web pages of the marketplace/billing/affiliate
 * settings family, sheets and modals (which keep their own close), the project
 * header (which composes the same glass circle button), or the IDE panels.
 * Out of scope for SHO-490 — listed so this guard only fires on new screens.
 */
const ALLOWED: Record<string, string> = {
  'app/(app)/account.tsx': 'wide-web account page',
  'app/(app)/ai-models.tsx': 'wide-web models page',
  'app/(app)/billing.tsx': 'wide-web billing page',
  'app/(app)/profile.tsx': 'wide-web profile page',
  'app/(app)/marketplace/[slug].tsx': 'marketplace pages keep their own rows',
  'app/(app)/marketplace/category/[slug].tsx': 'marketplace pages keep their own rows',
  'app/(app)/marketplace/creators/[id].tsx': 'marketplace pages keep their own rows',
  'app/(app)/marketplace/creators/index.tsx': 'marketplace pages keep their own rows',
  'app/(app)/marketplace/index.tsx': 'marketplace pages keep their own rows',
  'app/(app)/marketplace/installs.tsx': 'marketplace pages keep their own rows',
  'app/(app)/marketplace/packs.tsx': 'marketplace pages keep their own rows',
  'components/canvas/ExternalPreviewWebView.tsx': 'an in-app browser, not a screen',
  'components/island/IslandApp.tsx': 'the buddy island, not a screen',
  'components/layout/MobileSettingsSheet.tsx': 'a sheet keeps its own close',
  'components/project/panels/PlansPanel.tsx': 'a panel inside the project top bar',
  'components/project/topbar/native/NativePhoneHeader.tsx':
    'the project header: NativeCircleButton is the same glass circle',
  'components/team-chat/MessageActionSheet.tsx': 'a sheet keeps its own close',
  'components/team-chat/SessionBreadcrumb.tsx': 'a breadcrumb trail, not a back row',
  'app/(app)/affiliate/index.tsx': 'wide-web affiliate pages',
  'app/(app)/affiliate/commissions.tsx': 'wide-web affiliate pages',
  'app/(app)/affiliate/content.tsx': 'wide-web affiliate pages',
  'app/(app)/affiliate/downline.tsx': 'wide-web affiliate pages',
  'app/(app)/affiliate/enroll.tsx': 'wide-web affiliate pages',
  'app/(app)/affiliate/payouts.tsx': 'wide-web affiliate pages',
  'app/(app)/marketplace/creator/index.tsx': 'wide-web marketplace pages',
  'app/(app)/marketplace/creator/listing/[id].tsx': 'wide-web marketplace pages',
  'app/(app)/marketplace/creator/payout-setup.tsx': 'wide-web marketplace pages',
  'app/(app)/new-workspace.tsx': 'wide-web workspace page (an iOS notice card)',
  'app/(app)/api-keys.tsx': 'wide-web settings family',
  'components/layout/MobileWorkspaceShell.tsx':
    'composes NativeCircleButton, the same glass circle',
  'components/project/RemoteHostPickerModal.tsx': 'a modal keeps its own close',
  'components/onboarding/OnboardingStepper.tsx': 'a stepper, not a screen header',
  'components/analytics/WorkspaceActivitySection.tsx': 'an in-page back link',
  'components/analytics/SharedAnalytics.tsx': 'analytic cards and their paging arrows',
  'app/(app)/projects/index.tsx': 'a breadcrumb inside the project browser',
  'components/chat/ImagePreviewModal.tsx': 'a modal keeps its own close and pager',
  'components/chat/turns/AskUserQuestionWidget.tsx': 'a wizard step inside a chat turn',
  'components/layout/sidebar/AppSidebar.tsx': 'the sidebar drill-down, not a screen',
  'components/project/panels/AgentsPanel.tsx': 'an IDE panel inside the project top bar',
  'components/project/panels/FilesBrowserPanel.tsx': 'an IDE panel inside the project top bar',
  'components/project/panels/ide/EditorTabs.tsx': 'an IDE tab strip',
  'components/project/topbar/dropdown/ProjectMenuView.tsx': 'a dropdown menu, not a screen',
  'components/project/topbar/dropdown/ProjectSwitcherView.tsx': 'a dropdown menu, not a screen',
}

/**
 * Screens that must render the glass header. This is the card's A and B lists:
 * if one of them loses the header, the standard is broken again even though no
 * back row came back.
 */
const MUST_USE_THE_HEADER = [
  'components/boards/CardPane.tsx',
  'components/team-chat/FilesPane.tsx',
  'components/team-chat/DocPane.tsx',
  'components/team-chat/UserProfilePane.tsx',
  'components/chat/ShareFileViewer.tsx',
  'app/(app)/f/[attachmentId].tsx',
  'components/team-chat/ConversationHeader.tsx',
  'components/team-chat/TimelinePane.tsx',
  'components/team-chat/AgentProfileScreen.tsx',
  'components/team-chat/UserProfileScreen.tsx',
  'components/team-chat/NewConversationScreen.tsx',
  'components/workspace/WorkspaceChatsScreen.tsx',
  'components/personal/SideChatsScreen.tsx',
  'components/personal/GoalDetailScreen.tsx',
  'app/(app)/goals/[id].tsx',
  'app/(app)/notifications.tsx',
  'app/(app)/settings.tsx',
  'app/(app)/meetings/[id].tsx',
  'app/(app)/huddles/[huddleId]/notes.tsx',
  'app/(app)/project-chats.tsx',
  'components/project/ProjectSurfaceHeader.tsx',
]

/**
 * A back control of the retired shapes: a bare arrow — including the
 * `<ChevronLeft>` every hand-rolled phone back row used — or a "Back"
 * pressable. A close `X` is not listed: the same glyph is a chip's clear
 * button and a list row's dismiss all over the app, so a static scan cannot
 * tell those from a pane's close; the pane closes are held by
 * `e2e/local/phone-glass-header.test.ts` instead.
 */
const RETIRED_IDIOMS: RegExp[] = [
  /<ArrowLeft\b/,
  /<ChevronLeft\b/,
  /accessibilityLabel=\{?["'`]Back["'` ]/,
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = ROOTS.flatMap((root) => sourceFiles(join(MOBILE, root)))
const relative = (file: string) => file.slice(MOBILE.length + 1).replaceAll('\\', '/')
const read = (file: string) => readFileSync(join(MOBILE, file), 'utf8')

describe('the phone navigation standard', () => {
  test('a screen with its own back row fails, unless it is a documented non-phone surface', () => {
    const offenders = files
      .filter((file) => {
        const rel = relative(file)
        if (THE_STANDARD.includes(rel) || ALLOWED[rel]) return false
        const src = readFileSync(file, 'utf8')
        if (src.includes('PhoneScreenHeader')) return false
        return RETIRED_IDIOMS.some((idiom) => idiom.test(src))
      })
      .map(relative)

    expect(offenders).toEqual([])
  })

  test('every screen that had a hand-rolled header now renders the glass one', () => {
    const missing = MUST_USE_THE_HEADER.filter((file) => !read(file).includes('PhoneScreenHeader'))
    expect(missing).toEqual([])
  })

  test('the allow-list only names files that exist', () => {
    const present = new Set(files.map(relative))
    const stale = [...Object.keys(ALLOWED), ...THE_STANDARD, ...MUST_USE_THE_HEADER].filter(
      (file) => !present.has(file),
    )
    expect(stale).toEqual([])
  })

  test('there is one glass circle: the native circle button renders GlassButton', () => {
    const button = read('components/project/topbar/native/NativeCircleButton.tsx')
    expect(button).toContain('GlassButton')
    // No second copy of the glass surface.
    expect(button).not.toContain('LiquidGlassBackdrop')
  })

  test('the More-tab back control is glass, not a bare arrow', () => {
    const back = read('components/layout/PhoneBackButton.tsx')
    expect(back).toContain('GlassButton')
    expect(back).not.toContain('<ArrowLeft')
  })
})
