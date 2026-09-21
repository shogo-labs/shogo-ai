// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repro + regression coverage for the "Select shows the raw value (a UUID)
 * instead of the item's label" production pain point — reported verbatim
 * in the AI Insights digest on 2026-09-15 ("Select component showing UUID
 * instead of name — the SelectItem label registration fails when children
 * are JSX elements instead of strings") and again on 2026-09-20 ("Select
 * component displaying IDs instead of labels after user interaction,
 * requiring multiple fix attempts").
 *
 * Root cause: `SelectValue` rendered `{value || placeholder}` directly —
 * the raw `value` prop (typically a database id) — because it never had
 * any way to look up the human-readable label a sibling `SelectItem`
 * renders as its children (`<SelectItem value={id}>{name}</SelectItem>`).
 *
 * This reproduces the exact real-world flow from the digest reports: open
 * the dropdown (mounts the `SelectItem`s, which register their labels),
 * click an item (selects it, closes the dropdown, unmounting the items
 * again), and confirm `SelectValue` keeps showing the human label rather
 * than reverting to the raw value once the dropdown closes.
 */
import './happy-dom-setup.ts'
import { describe, test, expect, afterEach } from 'bun:test'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select'

afterEach(() => {
  cleanup()
})

describe('Select / SelectValue label resolution', () => {
  test('shows the SelectItem label (not the raw value) after opening and choosing an item', () => {
    const { container, getByText } = render(
      <Select defaultValue="">
        <SelectTrigger>
          <SelectValue placeholder="Pick a user" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="8f14e45f-ceea-467e-b7d1-9a7d1a4b0c1a">Alice</SelectItem>
          <SelectItem value="c9e1e5e0-1234-4a5b-9c8d-abcdef123456">Bob</SelectItem>
        </SelectContent>
      </Select>,
    )

    // Open the dropdown — this mounts the SelectItems, which is when they
    // get a chance to register their label.
    const trigger = container.querySelector('button')!
    fireEvent.click(trigger)

    // Choose "Alice" (the item rendering the uuid-1 value).
    fireEvent.click(getByText('Alice'))

    // The dropdown is now closed (SelectItem unmounted) and the selected
    // value is the uuid. SelectValue must still show the human label.
    expect(container.textContent).toContain('Alice')
    expect(container.textContent).not.toContain('8f14e45f-ceea-467e-b7d1-9a7d1a4b0c1a')
  })

  test('falls back to the raw value if no matching SelectItem has ever been mounted (no label known)', () => {
    const { container } = render(
      <Select value="never-registered-id">
        <SelectTrigger>
          <SelectValue placeholder="Pick a user" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="other-id">Someone Else</SelectItem>
        </SelectContent>
      </Select>,
    )
    expect(container.textContent).toContain('never-registered-id')
  })

  test('shows the placeholder when nothing is selected', () => {
    const { container } = render(
      <Select defaultValue="">
        <SelectTrigger>
          <SelectValue placeholder="Pick a user" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alice</SelectItem>
        </SelectContent>
      </Select>,
    )
    expect(container.textContent).toContain('Pick a user')
  })

  test('switching selection updates the label (not stuck on the first-registered one)', () => {
    const { container, getByText } = render(
      <Select defaultValue="">
        <SelectTrigger>
          <SelectValue placeholder="Pick a user" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="id-alice">Alice</SelectItem>
          <SelectItem value="id-bob">Bob</SelectItem>
        </SelectContent>
      </Select>,
    )
    const trigger = container.querySelector('button')!

    fireEvent.click(trigger)
    fireEvent.click(getByText('Alice'))
    expect(container.textContent).toContain('Alice')

    fireEvent.click(trigger)
    fireEvent.click(getByText('Bob'))
    expect(container.textContent).toContain('Bob')
    expect(container.textContent).not.toContain('Alice')
  })
})
