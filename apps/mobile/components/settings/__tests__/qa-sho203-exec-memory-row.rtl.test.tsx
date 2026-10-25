// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-203 acceptance — the Settings surface users actually touch.
 *
 * The card's third requirement is that a user can see and change the budget from
 * Settings → Computer and files instead of hand-editing `config.json` and
 * restarting, and that the copy says so. That row is the only fix an affected
 * user has; a defect here (a row that renders the wrong number, a preset that
 * sends the wrong MB, a swallowed error) leaves them exactly where the card
 * started, so it is exercised through the real panel and the real bridge
 * contract rather than through the pure helpers.
 *
 *   bun test apps/mobile/components/settings/__tests__/qa-sho203-exec-memory-row.rtl.test.tsx
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ accessibilityRole, accessibilityLabel, accessibilityState, testID, children, disabled, onPress }: any) =>
      createElement(
        'button',
        {
          type: 'button',
          role: accessibilityRole ?? 'button',
          'aria-label': accessibilityLabel,
          'aria-selected': accessibilityState?.selected ? 'true' : undefined,
          'data-testid': testID,
          'data-rn-shim': testID,
          disabled: disabled ? true : undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
    TextInput: ({ value, onChangeText, onSubmitEditing, placeholder, testID }: any) =>
      createElement('input', {
        value,
        placeholder,
        'data-testid': testID,
        'data-rn-shim': testID,
        onChange: (e: any) => onChangeText?.(e.target.value),
        onKeyDown: (e: any) => {
          if (e.key === 'Enter') onSubmitEditing?.()
        },
      }),
    Text: ({ children, testID }: any) =>
      createElement('span', { 'data-testid': testID, 'data-rn-shim': testID }, children),
    View: ({ children }: any) => createElement('div', null, children),
  } as any),
)

mock.module('@shogo/shared-ui/primitives', () => {
  const passthrough = ({ children }: any) => createElement('div', null, children)
  return {
    Button: ({ children, onPress, accessibilityLabel, disabled }: any) =>
      createElement(
        'button',
        { type: 'button', 'aria-label': accessibilityLabel, disabled: disabled ? true : undefined, onClick: onPress },
        children,
      ),
    Switch: ({ checked, onCheckedChange }: any) =>
      createElement('input', {
        type: 'checkbox',
        checked: !!checked,
        onChange: () => onCheckedChange?.(!checked),
      }),
    Card: passthrough,
    CardContent: passthrough,
    cn: (...parts: any[]) => parts.flat().filter(Boolean).join(' '),
  }
})
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => ({ baseUrl: 'https://api.test' }) }))
mock.module('../../../lib/api', () => ({
  api: {
    getLocalAccessPrefs: async () => ({ prefs: {} }),
    saveLocalAccessPrefs: async (_http: unknown, patch: Record<string, unknown>) => ({ prefs: patch }),
  },
}))
mock.module('../../../lib/use-os-permissions', () => ({
  useOsPermissions: () => ({
    status: { accessibility: 'granted', screen: 'granted', fullDisk: 'granted', dictation: 'granted' },
    requesting: null,
    request: () => {},
  }),
  useLocalApps: () => ({ apps: [], loaded: true }),
}))

type HostConfig = {
  memoryMB: number
  cpuPercent: number
  execMemoryMB: number | 'auto'
  resolvedExecMemoryMB: number
  totalMemMB: number
}

const GB = 1024
const TOTAL_MB = 128 * GB

let hostConfig: HostConfig
let setResult: ((patch: { execMemoryMB?: number | 'auto' }) => Promise<any>) | null
let setCalls: Array<{ execMemoryMB?: number | 'auto' }>
let getCalls = 0

mock.module('../../../lib/desktop-bridge', () => ({
  getDesktopBridge: () => ({
    getHostRuntimeConfig: async () => {
      getCalls++
      return hostConfig
    },
    setHostRuntimeConfig: async (patch: { execMemoryMB?: number | 'auto' }) => {
      setCalls.push(patch)
      if (setResult) return setResult(patch)
      return { ok: true, config: applySetting(patch.execMemoryMB!) }
    },
  }),
}))

const { defaultLocalAccess } = await import('../../../lib/local-access')
const { ComputerAndFilesPanel } = await import('../ComputerAndFilesPanel')

/** What the desktop's IPC handler does with a value: clamp to the machine. */
function applySetting(execMemoryMB: number | 'auto'): HostConfig {
  const resolved =
    execMemoryMB === 'auto' ? 120 * GB : Math.min(Math.max(Math.round(execMemoryMB), 1024), TOTAL_MB)
  hostConfig = { ...hostConfig, execMemoryMB, resolvedExecMemoryMB: resolved }
  return hostConfig
}

beforeEach(() => {
  hostConfig = {
    memoryMB: 8 * GB,
    cpuPercent: 0,
    execMemoryMB: 'auto',
    resolvedExecMemoryMB: 120 * GB,
    totalMemMB: TOTAL_MB,
  }
  setResult = null
  setCalls = []
  getCalls = 0
  const prefs = defaultLocalAccess()
  mock.module('../../../lib/api', () => ({
    api: {
      getLocalAccessPrefs: async () => ({ prefs }),
      saveLocalAccessPrefs: async (_http: unknown, patch: Record<string, unknown>) => ({ prefs }),
    },
  }))
})

afterEach(() => cleanup())

const byTestId = (id: string) => document.querySelector(`[data-rn-shim="${id}"]`) as HTMLElement | null
const currentText = () => byTestId('exec-memory-current')?.textContent ?? ''

async function renderPanel() {
  render(createElement(ComputerAndFilesPanel))
  await waitFor(() => {
    if (!byTestId('exec-memory-current')) throw new Error('memory row not rendered yet')
  })
}

describe('SHO-203 Settings → Memory for agent commands', () => {
  test('shows the resolved budget and this machine’s RAM, and says it applies without a restart', async () => {
    await renderPanel()
    expect(currentText()).toBe('Auto — 120 GB of 128 GB')

    // The reason the old hand-edit was unusable: nothing said it needed a
    // restart. This copy has to promise the opposite, in the panel itself.
    const description = document.body.textContent ?? ''
    expect(description).toContain('Memory for agent commands')
    expect(description).toContain('applies immediately, with no restart')
    // The runtime's own leak ceiling is a different number and must not be
    // shown as the command budget.
    expect(description).not.toContain('8 GB of 128 GB')
  })

  test('an explicit setting shows its value, not "Auto"', async () => {
    hostConfig = applySetting(24 * GB)
    await renderPanel()
    expect(currentText()).toBe('24 GB of 128 GB')
    expect(currentText()).not.toContain('Auto')
  })

  test('picking a preset sends that share of this machine’s RAM, and the row follows', async () => {
    await renderPanel()
    const fifty = byTestId('exec-memory-50')!
    expect(fifty.textContent).toContain('50%')

    fireEvent.click(fifty)
    await waitFor(() => expect(currentText()).toBe('64 GB of 128 GB'))

    expect(setCalls).toEqual([{ execMemoryMB: 64 * GB }])
    // …and the selected chip reflects what was saved.
    expect(byTestId('exec-memory-50')!.getAttribute('aria-selected')).toBe('true')
  })

  test('Auto goes back to the host-derived budget', async () => {
    hostConfig = applySetting(24 * GB)
    await renderPanel()
    expect(currentText()).toBe('24 GB of 128 GB')

    fireEvent.click(byTestId('exec-memory-auto')!)
    await waitFor(() => expect(currentText()).toBe('Auto — 120 GB of 128 GB'))
    expect(setCalls).toEqual([{ execMemoryMB: 'auto' }])
  })

  test('a custom GB value is sent as MB, clamped to the machine', async () => {
    await renderPanel()
    const input = byTestId('exec-memory-custom') as HTMLInputElement
    fireEvent.change(input, { target: { value: '40' } })
    fireEvent.click(screen.getByText('Set'))

    await waitFor(() => expect(currentText()).toBe('40 GB of 128 GB'))
    expect(setCalls).toEqual([{ execMemoryMB: 40 * GB }])

    // Asking for more than the machine has must not promise it: the desktop
    // clamps, and the row shows what was actually saved.
    fireEvent.change(input, { target: { value: '900' } })
    fireEvent.click(screen.getByText('Set'))
    await waitFor(() => expect(currentText()).toBe('128 GB of 128 GB'))
    expect(setCalls[1]).toEqual({ execMemoryMB: 900 * GB })
  })

  test('a save the desktop refuses shows its reason instead of silently keeping the old value', async () => {
    setResult = async () => ({
      ok: false,
      error: 'Could not write host-limits.json (EACCES)',
      config: hostConfig,
    })
    await renderPanel()

    fireEvent.click(byTestId('exec-memory-75')!)
    await waitFor(() => expect(document.body.textContent).toContain('EACCES'))
    // Still the value that is actually in effect.
    expect(currentText()).toBe('Auto — 120 GB of 128 GB')
  })

  test('reads the current value from the desktop once, not on every render', async () => {
    await renderPanel()
    expect(getCalls).toBe(1)
  })
})
