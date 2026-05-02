// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Smoke test verifying the bun:test + happy-dom + RTL stack is wired up
 * correctly via the two-file preload. If this fails, the rest of the
 * component test suite cannot run.
 */
import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

function Counter() {
  const [n, setN] = useState(0)
  return (
    <div>
      <span aria-label="count">{n}</span>
      <button type="button" onClick={() => setN(n + 1)}>
        Increment
      </button>
    </div>
  )
}

describe('rtl smoke', () => {
  test('happy-dom + RTL render and userEvent click work', async () => {
    const user = userEvent.setup()
    render(<Counter />)
    expect(screen.getByLabelText('count')).toHaveTextContent('0')
    await user.click(screen.getByRole('button', { name: /increment/i }))
    expect(screen.getByLabelText('count')).toHaveTextContent('1')
  })

  test('jest-dom matchers extend bun:test expect', () => {
    render(<button type="button">click me</button>)
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument()
  })
})
